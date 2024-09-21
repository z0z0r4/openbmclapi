import { createHash } from 'crypto';
import { join } from 'path';
export function hashToFilename(hash) {
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    return join(hash.substring(0, 2), hash);
}
export function checkSign(hash, secret, query) {
    const { s, e } = query;
    if (!s || !e)
        return false;
    const sha1 = createHash('sha1');
    const toSign = [secret, hash, e];
    for (const str of toSign) {
        sha1.update(str);
    }
    const sign = sha1.digest('base64url');
    return sign === s && Date.now() < parseInt(e, 36);
}
//# sourceMappingURL=util.js.map