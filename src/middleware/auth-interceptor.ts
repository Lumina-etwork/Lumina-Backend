import { validateToken } from '../auth/token-validator';

export async function authInterceptor(req: any, res: any, next: any) {
    // Region-local JWKS endpoint, populated by the gossip layer
    if (req.path === '/.well-known/jwks.json') {
        // Tokens can be validated entirely locally using these keys
        return res.json({ keys: [] }); // Stub for returning JWKS
    }

    const token = req.headers['authorization'];
    if (token) {
        // Validates locally first, cross-region relay is fallback
        const isValid = await validateToken(token);
        if (!isValid) {
            return res.status(401).send('Unauthorized');
        }
    }
    
    next();
}
