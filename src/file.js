import { createHash } from 'crypto';
export function validateFile(buffer, checkSum) {
    let hash;
    if (checkSum.length === 32) {
        hash = createHash('md5');
    }
    else {
        hash = createHash('sha1');
    }
    hash.update(buffer);
    return hash.digest('hex') === checkSum;
}
//# sourceMappingURL=file.js.map