import Bluebird from 'bluebird';
import colors from 'colors/safe.js';
import fse from 'fs-extra';
import { readdir, rm, stat, unlink, writeFile } from 'fs/promises';
import { min } from 'lodash-es';
import { join, sep } from 'path';
import { logger } from '../logger.js';
import { hashToFilename } from '../util.js';
export class FileStorage {
    cacheDir;
    constructor(cacheDir) {
        this.cacheDir = cacheDir;
    }
    async check() {
        try {
            await fse.mkdirp(this.cacheDir);
            await writeFile(join(this.cacheDir, '.check'), '');
            return true;
        }
        catch (e) {
            logger.error(e, '存储检查异常');
            return false;
        }
        finally {
            await rm(join(this.cacheDir, '.check'), { recursive: true, force: true });
        }
    }
    async writeFile(path, content) {
        await fse.outputFile(join(this.cacheDir, path), content);
    }
    async exists(path) {
        return await fse.pathExists(join(this.cacheDir, path));
    }
    getAbsolutePath(path) {
        return join(this.cacheDir, path);
    }
    async getMissingFiles(files) {
        return await Bluebird.filter(files, async (file) => {
            const st = await stat(join(this.cacheDir, hashToFilename(file.hash))).catch(() => null);
            return st?.size !== file.size;
        }, {
            concurrency: 1e3,
        });
    }
    async gc(files) {
        const fileSet = new Set();
        for (const file of files) {
            fileSet.add(hashToFilename(file.hash));
        }
        const queue = [this.cacheDir];
        do {
            const dir = queue.pop();
            if (!dir)
                break;
            const entries = await readdir(dir);
            for (const entry of entries) {
                const p = join(dir, entry);
                const s = await stat(p);
                if (s.isDirectory()) {
                    queue.push(p);
                    continue;
                }
                const cacheDirWithSep = this.cacheDir + sep;
                if (!fileSet.has(p.replace(cacheDirWithSep, ''))) {
                    logger.info(colors.gray(`delete expire file: ${p}`));
                    await unlink(p);
                }
            }
        } while (queue.length !== 0);
    }
    async express(hashPath, req, res) {
        const name = req.query.name;
        if (name) {
            res.attachment(name);
        }
        const path = this.getAbsolutePath(hashPath);
        return await new Promise((resolve, reject) => {
            res.sendFile(path, { maxAge: '30d' }, (err) => {
                let bytes = res.socket?.bytesWritten ?? 0;
                if (!err || err?.message === 'Request aborted' || err?.message === 'write EPIPE') {
                    const header = res.getHeader('content-length');
                    if (header) {
                        const contentLength = parseInt(header.toString(), 10);
                        bytes = min([bytes, contentLength]) ?? 0;
                    }
                    resolve({ bytes, hits: 1 });
                }
                else {
                    if (err) {
                        return reject(err);
                    }
                    resolve({ bytes: 0, hits: 0 });
                }
            });
        });
    }
}
//# sourceMappingURL=file.storage.js.map