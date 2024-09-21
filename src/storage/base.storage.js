import { join } from 'path';
import { logger } from '../logger.js';
import { AlistWebdavStorage } from './alist-webdav.storage.js';
import { FileStorage } from './file.storage.js';
export function getStorage(config) {
    let storage;
    switch (config.storage) {
        case 'file':
            storage = new FileStorage(join(process.cwd(), 'cache'));
            break;
        case 'alist':
            storage = new AlistWebdavStorage(config.storageOpts);
            break;
        default:
            throw new Error(`未知的存储类型${config.storage}`);
    }
    logger.info(`使用存储类型: ${config.storage}`);
    return storage;
}
//# sourceMappingURL=base.storage.js.map