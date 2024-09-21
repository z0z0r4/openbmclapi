import nodeCluster from 'cluster';
import colors from 'colors/safe.js';
import { HTTPError } from 'got';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { Cluster } from './cluster.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { TokenManager } from './token.js';
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = fileURLToPath(new URL('.', import.meta.url));
export async function bootstrap(version) {
    logger.info(colors.green(`booting openbmclapi ${version}`));
    const tokenManager = new TokenManager(config.clusterId, config.clusterSecret, version);
    await tokenManager.getToken();
    const cluster = new Cluster(config.clusterSecret, version, tokenManager);
    await cluster.init();
    const storageReady = await cluster.storage.check();
    if (!storageReady) {
        throw new Error('存储异常');
    }
    const configuration = await cluster.getConfiguration();
    const files = await cluster.getFileList();
    logger.info(`${files.files.length} files`);
    try {
        await cluster.syncFiles(files, configuration.sync);
    }
    catch (e) {
        if (e instanceof HTTPError) {
            logger.error({ url: e.response.url }, 'download error');
        }
        throw e;
    }
    logger.info('回收文件');
    cluster.storage.gc(files.files).catch((e) => {
        logger.error({ err: e }, 'gc error');
    });
    cluster.connect();
    const proto = config.byoc ? 'http' : 'https';
    if (proto === 'https') {
        logger.info('请求证书');
        await cluster.requestCert();
    }
    if (config.enableNginx) {
        if (typeof cluster.port === 'number') {
            await cluster.setupNginx(join(__dirname, '..'), cluster.port, proto);
        }
        else {
            throw new Error('cluster.port is not a number');
        }
    }
    const server = cluster.setupExpress(proto === 'https' && !config.enableNginx);
    try {
        logger.info('请求上线');
        await cluster.listen();
        await cluster.enable();
        logger.info(colors.rainbow(`done, serving ${files.files.length} files`));
        if (nodeCluster.isWorker && typeof process.send === 'function') {
            process.send('ready');
        }
    }
    catch (e) {
        logger.fatal(e);
        if (process.env.NODE_ENV === 'development') {
            logger.fatal('development mode, not exiting');
        }
        else {
            cluster.exit(1);
        }
    }
    let stopping = false;
    const onStop = async (signal) => {
        console.log(`got ${signal}, unregistering cluster`);
        if (stopping) {
            // eslint-disable-next-line n/no-process-exit
            process.exit(1);
        }
        stopping = true;
        if (cluster.interval) {
            clearInterval(cluster.interval);
        }
        await cluster.disable();
        // eslint-disable-next-line no-console
        console.log('unregister success, waiting for background task, ctrl+c again to force kill');
        server.close();
        cluster.nginxProcess?.kill();
    };
    process.once('SIGTERM', (signal) => {
        void onStop(signal);
    });
    process.once('SIGINT', (signal) => {
        void onStop(signal);
    });
    if (nodeCluster.isWorker) {
        process.on('disconnect', () => {
            void onStop('disconnect');
        });
    }
}
//# sourceMappingURL=bootstrap.js.map