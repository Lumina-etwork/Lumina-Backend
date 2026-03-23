const { Beneficiary, Vault, SubSchedule } = require('../models');

const CALENDAR_PROD_ID = '-//Vesting Vault//Token Unlock Calendar//EN';
const MAJOR_MILESTONE_FRACTIONS = [0.25, 0.5, 0.75, 1];

const parseNumeric = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatAmount = (value) => {
  const rounded = parseNumeric(value).toFixed(6);
  return rounded.replace(/\.?0+$/, '');
};

const escapeICalText = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');

const formatICalDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
};

class CalendarService {
  parseFromDate(from) {
    if (!from) {
      return new Date();
    }

    const parsed = new Date(from);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid from date');
    }

    return parsed;
  }

  buildCalendarFileName(beneficiaryAddress) {
    const safeAddress = String(beneficiaryAddress || 'beneficiary')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    return `vesting-unlocks-${safeAddress || 'beneficiary'}.ics`;
  }

  buildUid(beneficiaryAddress, scheduleId, suffix) {
    const safeAddress = String(beneficiaryAddress || 'beneficiary')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    return `${safeAddress}-${scheduleId}-${suffix}@vesting-vault`;
  }

  getVaultLabel(vault) {
    if (vault.name) {
      return vault.name;
    }

    if (!vault.address) {
      return 'Unnamed vault';
    }

    return `Vault ${vault.address.slice(0, 10)}...`;
  }

  buildCliffEvent({ beneficiaryAddress, beneficiaryAmount, schedule, vault }) {
    const cliffDate = new Date(schedule.cliff_date || schedule.vesting_start_date);
    const unlocksImmediately = parseNumeric(schedule.vesting_duration) <= 0;

    const description = [
      `Beneficiary: ${beneficiaryAddress}`,
      `Vault: ${vault.address}`,
      `Token: ${vault.token_address}`,
      `Schedule transaction: ${schedule.transaction_hash}`,
      `Estimated beneficiary allocation for this top-up: ${formatAmount(beneficiaryAmount)} tokens`,
      unlocksImmediately
        ? 'This cliff end fully unlocks the tracked beneficiary allocation.'
        : 'Linear vesting starts when this cliff ends.',
    ].join('\n');

    return {
      uid: this.buildUid(beneficiaryAddress, schedule.id, 'cliff'),
      startsAt: cliffDate,
      summary: `Cliff ends for ${this.getVaultLabel(vault)}`,
      description,
      categories: ['CLIFF', 'TOKEN_UNLOCK'],
    };
  }

  buildMilestoneEvent({ beneficiaryAddress, beneficiaryAmount, fraction, schedule, startsAt, vault }) {
    const percentage = Math.round(fraction * 100);
    const unlockedAmount = beneficiaryAmount * fraction;

    const description = [
      `Beneficiary: ${beneficiaryAddress}`,
      `Vault: ${vault.address}`,
      `Token: ${vault.token_address}`,
      `Schedule transaction: ${schedule.transaction_hash}`,
      `Milestone: ${percentage}% vested`,
      `Estimated beneficiary amount unlocked by this milestone: ${formatAmount(unlockedAmount)} tokens`,
      `Estimated beneficiary allocation for this top-up: ${formatAmount(beneficiaryAmount)} tokens`,
    ].join('\n');

    return {
      uid: this.buildUid(beneficiaryAddress, schedule.id, `milestone-${percentage}`),
      startsAt,
      summary: `${percentage}% unlock milestone for ${this.getVaultLabel(vault)}`,
      description,
      categories: ['MILESTONE', 'TOKEN_UNLOCK'],
    };
  }

  async getUpcomingUnlockEvents(beneficiaryAddress, options = {}) {
    const from = this.parseFromDate(options.from);

    const beneficiaryRecords = await Beneficiary.findAll({
      where: { address: beneficiaryAddress },
      include: [
        {
          model: Vault,
          as: 'vault',
          required: true,
          include: [
            {
              model: SubSchedule,
              as: 'subSchedules',
              required: false,
              where: { is_active: true },
            },
          ],
        },
      ],
    });

    const events = [];

    for (const beneficiary of beneficiaryRecords) {
      const vault = beneficiary.vault;
      if (!vault) {
        continue;
      }

      const totalAllocated = parseNumeric(beneficiary.total_allocated);
      const totalVaultAmount = parseNumeric(vault.total_amount);
      const allocationRatio =
        totalVaultAmount > 0 ? Math.min(1, totalAllocated / totalVaultAmount) : 0;

      if (allocationRatio <= 0) {
        continue;
      }

      const subSchedules = Array.isArray(vault.subSchedules) ? vault.subSchedules : [];

      for (const schedule of subSchedules) {
        const topUpAmount = parseNumeric(schedule.top_up_amount);
        if (topUpAmount <= 0) {
          continue;
        }

        const beneficiaryAmount = topUpAmount * allocationRatio;
        if (beneficiaryAmount <= 0) {
          continue;
        }

        const hasCliff = parseNumeric(schedule.cliff_duration) > 0 && schedule.cliff_date;
        const cliffDate = hasCliff ? new Date(schedule.cliff_date) : null;

        if (cliffDate && cliffDate.getTime() >= from.getTime()) {
          events.push(
            this.buildCliffEvent({
              beneficiaryAddress,
              beneficiaryAmount,
              schedule,
              vault,
            })
          );
        }

        const vestingStartDate = new Date(schedule.vesting_start_date);
        const vestingDurationSeconds = parseNumeric(schedule.vesting_duration);

        if (vestingDurationSeconds > 0) {
          for (const fraction of MAJOR_MILESTONE_FRACTIONS) {
            const startsAt = new Date(
              vestingStartDate.getTime() + vestingDurationSeconds * fraction * 1000
            );

            if (startsAt.getTime() < from.getTime()) {
              continue;
            }

            events.push(
              this.buildMilestoneEvent({
                beneficiaryAddress,
                beneficiaryAmount,
                fraction,
                schedule,
                startsAt,
                vault,
              })
            );
          }

          continue;
        }

        if (!hasCliff && vestingStartDate.getTime() >= from.getTime()) {
          events.push(
            this.buildMilestoneEvent({
              beneficiaryAddress,
              beneficiaryAmount,
              fraction: 1,
              schedule,
              startsAt: vestingStartDate,
              vault,
            })
          );
        }
      }
    }

    events.sort((left, right) => {
      const timeDifference = left.startsAt.getTime() - right.startsAt.getTime();
      if (timeDifference !== 0) {
        return timeDifference;
      }

      return left.summary.localeCompare(right.summary);
    });

    return events;
  }

  renderICalFeed(beneficiaryAddress, events, generatedAt = new Date()) {
    const calendarName = `Vesting Vault Unlocks - ${beneficiaryAddress}`;
    const description =
      'Track upcoming cliff endings and major unlock milestones across Vesting Vault schedules.';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${CALENDAR_PROD_ID}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeICalText(calendarName)}`,
      `X-WR-CALDESC:${escapeICalText(description)}`,
      'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
      'X-PUBLISHED-TTL:PT6H',
    ];

    for (const event of events) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${escapeICalText(event.uid)}`,
        `DTSTAMP:${formatICalDate(generatedAt)}`,
        `DTSTART:${formatICalDate(event.startsAt)}`,
        'DURATION:PT30M',
        `SUMMARY:${escapeICalText(event.summary)}`,
        `DESCRIPTION:${escapeICalText(event.description)}`,
        `CATEGORIES:${event.categories.map((category) => escapeICalText(category)).join(',')}`,
        'STATUS:CONFIRMED',
        'TRANSP:TRANSPARENT',
        'END:VEVENT'
      );
    }

    lines.push('END:VCALENDAR');

    return `${lines.join('\r\n')}\r\n`;
  }

  async buildBeneficiaryCalendarFeed(beneficiaryAddress, options = {}) {
    const events = await this.getUpcomingUnlockEvents(beneficiaryAddress, options);

    return {
      events,
      fileName: this.buildCalendarFileName(beneficiaryAddress),
      ics: this.renderICalFeed(beneficiaryAddress, events),
    };
  }
}

module.exports = new CalendarService();
