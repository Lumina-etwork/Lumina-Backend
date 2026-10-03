/**
 * Demographic-blind profile sanitizer and merit ranker (Lumina Network / SDG 5).
 *
 * The invariant this module exists to guarantee: nothing derived from a
 * candidate's identity -- name, gender, age, location, ethnicity, photo,
 * employer prestige -- may reach the matching engine or the client. Only
 * cryptographically or numerically verifiable output survives.
 */

/** Keys that must never appear anywhere in a sanitized profile. */
const PROHIBITED_KEYS = new Set([
  'name', 'first_name', 'firstname', 'last_name', 'lastname', 'full_name', 'fullname',
  'surname', 'display_name', 'displayname', 'username', 'handle', 'nickname',
  'gender', 'sex', 'gender_identity', 'sexual_orientation', 'pronouns',
  'age', 'birth_date', 'birthdate', 'dob', 'year_of_birth',
  'photo', 'avatar', 'profile_picture', 'profilepicture', 'headshot', 'image', 'images',
  'location', 'country', 'city', 'state', 'region', 'address_line', 'zip', 'postcode',
  'nationality', 'ethnicity', 'race', 'religion',
  'email', 'phone', 'contact',
  'university', 'college', 'school', 'employer', 'company', 'alma_mater', 'prestige',
  'title', 'salary', 'referral_source',
]);

/** Substrings that mark an identity-derived key even if not listed verbatim. */
const PROHIBITED_SUBSTRINGS = [
  'name', 'gender', 'sex', 'age', 'birth', 'photo', 'avatar', 'picture', 'image',
  'location', 'city', 'country', 'nationality', 'ethnic', 'race', 'religion',
  'university', 'college', 'school', 'employer', 'alma', 'prestige', 'pronoun',
];

/** Free-text tokens stripped from bios and skill blurbs. */
const IDENTITY_TOKENS = new Set([
  'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs',
  'man', 'men', 'woman', 'women', 'boy', 'girl', 'male', 'female', 'nonbinary',
  'non-binary', 'mother', 'father', 'mom', 'dad', 'husband', 'wife', 'son', 'daughter',
  'mr', 'mrs', 'ms', 'miss', 'sir', 'madam', 'girls', 'boys',
]);

/** Honorifics / prestige cues that signal institution or social rank. */
const PRESTIGE_TOKENS = new Set([
  'ivy', 'elite', 'top-tier', 'prestigious', 'renowned', 'famous', 'ex-google',
  'ex-meta', 'ex-apple', 'faang', 'silicon-valley', ' Fortune',
]);

/** The only skill/merit fields we permit through, in output order. */
const ALLOWED_OUTPUT_KEYS = [
  'node_id',
  'merit_score',
  'verified_skills',
  'completed_escrows',
  'milestone_completion_rate',
  'anchored_assets',
];

const isProhibitedKey = (key) => {
  const k = String(key).toLowerCase();
  if (PROHIBITED_KEYS.has(k)) return true;
  return PROHIBITED_SUBSTRINGS.some((sub) => k.includes(sub));
};

/**
 * Strip gendered/identity prose from free text. Deliberately conservative: it
 * removes whole words only, so "manage", "heritage" and "village" survive intact.
 */
export function scrubProse(text) {
  if (typeof text !== 'string') return '';
  return text
    .split(/\s+/)
    .filter((token) => {
      const bare = token.toLowerCase().replace(/[^a-z-]/g, '');
      if (!bare) return true;
      return !IDENTITY_TOKENS.has(bare) && !PRESTIGE_TOKENS.has(bare);
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Stable, non-reversible pseudonym so the same node keeps one label. */
export function pseudonymize(address, salt = 'lumina') {
  const input = String(address ?? '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= salt.split('').reduce((acc, ch) => Math.imul(acc ^ ch.charCodeAt(0), 16777619), 0);
  const id = (hash >>> 0) % 1000;
  return `Node #${String(id).padStart(3, '0')}`;
}

/** Coerce the several shapes a skills field arrives in into a clean array. */
function normalizeSkills(value) {
  if (Array.isArray(value)) return value.map((s) => scrubProse(String(s))).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeSkills(parsed);
    } catch {
      /* fall through to delimiter split */
    }
    return value.split(/[,;|]/).map((s) => scrubProse(s)).filter(Boolean);
  }
  return [];
}

const toCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/**
 * Convert an arbitrary raw profile into the blind, merit-only shape.
 * Unknown fields are dropped entirely rather than copied through.
 */
export function sanitizeProfile(rawProfile = {}) {
  const source = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};

  const completedEscrows = toCount(source.completed_escrows ?? source.completedEscrows);
  const totalMilestones = toCount(source.total_milestones ?? source.totalMilestones);
  const completedMilestones = toCount(source.completed_milestones ?? source.completedMilestones);

  const rawRate = source.milestone_completion_rate ?? source.milestoneCompletionRate;
  const completionRate =
    rawRate !== undefined && rawRate !== null
      ? Math.min(100, Math.max(0, Number(rawRate) || 0))
      : totalMilestones > 0
        ? Math.round((completedMilestones / totalMilestones) * 100)
        : completedEscrows > 0
          ? 100
          : 0;

  const anchoredAssets = toCount(source.anchored_assets ?? source.anchoredAssets ?? source.asset_count);

  return {
    node_id: pseudonymize(source.address ?? source.node_id ?? 'anonymous'),
    merit_score: Math.min(1000, Math.max(0, Math.round(Number(source.merit_score ?? source.meritScore) || 0))),
    verified_skills: normalizeSkills(source.verified_skills ?? source.verifiedSkills ?? source.skills),
    completed_escrows: completedEscrows,
    milestone_completion_rate: completionRate,
    anchored_assets: anchoredAssets,
  };
}

/**
 * Rank candidates on verifiable output only.
 *
 * score = 0.6 * normalizedSkillOverlap + 0.25 * meritScore/100 + 0.15 * completionRate/100
 *
 * No demographic attribute is read, so none can influence the ordering.
 */
export function rankCandidates(requirements = {}, candidatePool = []) {
  const requiredSkills = normalizeSkills(
    requirements.required_skills ?? requirements.requiredSkills ?? requirements.skills,
  );
  const minMerit = Number(requirements.min_merit_score ?? requirements.minMeritScore ?? 0) || 0;
  const minCompletion = Number(
    requirements.min_completion_rate ?? requirements.minCompletionRate ?? 0,
  ) || 0;

  const pool = Array.isArray(candidatePool) ? candidatePool : [];
  const wanted = new Set(requiredSkills.map((s) => s.toLowerCase()));
  const ceiling = Math.min(1000, Math.max(1, ...pool.map((c) => Number(c?.merit_score) || 0)));

  const scored = pool.map((candidate) => {
    // Re-sanitize on the way out: a caller passing raw rows cannot leak identity.
    const blind = sanitizeProfile(candidate);
    const have = new Set(blind.verified_skills.map((s) => s.toLowerCase()));

    // Match case-insensitively but report the caller's original spelling.
    const matched = requiredSkills.filter((skill) => have.has(skill.toLowerCase()));
    const overlap = wanted.size === 0 ? 1 : matched.length / wanted.size;

    const meritComponent = (blind.merit_score / ceiling) * 100;
    const score = 0.6 * overlap * 100 + 0.25 * meritComponent + 0.15 * blind.milestone_completion_rate;

    return {
      ...blind,
      matched_skills: matched,
      match_score: Math.round(score * 100) / 100,
    };
  });

  return scored
    .filter((c) => c.merit_score >= minMerit)
    .filter((c) => c.milestone_completion_rate >= minCompletion)
    .sort((a, b) => b.match_score - a.match_score || b.merit_score - a.merit_score);
}

export const PROHIBITED_PROFILE_KEYS = [...PROHIBITED_KEYS];
