import { spawn } from 'child_process';
import colors from 'colors/safe.js';
import delay from 'delay';
import express from 'express';
import { readFileSync } from 'fs';
import fse from 'fs-extra';
import { mkdtemp, open, readFile, rm } from 'fs/promises';
import got, { HTTPError } from 'got';
import { createServer } from 'http';
import { createSecureServer } from 'http2';
import http2Express from 'http2-express-bridge';
import { Agent as HttpsAgent } from 'https';
import { template } from 'lodash-es';
import morgan from 'morgan';
import ms from 'ms';
import { userInfo } from 'node:os';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { connect } from 'socket.io-client';
import { Tail } from 'tail';
import { fileURLToPath } from 'url';
import { config, OpenbmclapiAgentConfigurationSchema } from './config.js';
import { Keepalive } from './keepalive.js';
import { logger } from './logger.js';
import { AuthRouteFactory } from './routes/auth.route.js';
import MeasureRouteFactory from './routes/measure.route.js';
import { getStorage } from './storage/base.storage.js';
import { setupUpnp } from './upnp.js';
import { checkSign } from './util.js';
const whiteListDomain = ['localhost', 'bangbang93.com', 'files.mcimirror.top'];
// eslint-disable-next-line @typescript-eslint/naming-convention
const __dirname = dirname(fileURLToPath(import.meta.url));
export class Cluster {
    clusterSecret;
    version;
    tokenManager;
    counters = { hits: 0, bytes: 0 };
    isEnabled = false;
    wantEnable = false;
    interval;
    nginxProcess;
    storage;
    prefixUrl = process.env.CLUSTER_BMCLAPI ?? 'https://openbmclapi.bangbang93.com';
    host;
    _port;
    publicPort;
    ua;
    got;
    requestCache = new Map();
    tmpDir = join(tmpdir(), 'openbmclapi');
    keepalive = new Keepalive(ms('1m'), this);
    socket;
    files = [];
    server;
    constructor(clusterSecret, version, tokenManager) {
        this.clusterSecret = clusterSecret;
        this.version = version;
        this.tokenManager = tokenManager;
        this.host = config.clusterIp;
        this._port = config.port;
        this.publicPort = config.clusterPublicPort ?? config.port;
        this.ua = `openbmclapi-cluster/${version}`;
        this.got = got.extend({
            prefixUrl: this.prefixUrl,
            headers: {
                'user-agent': this.ua,
            },
            responseType: 'buffer',
            timeout: {
                connect: ms('10s'),
                response: ms('10s'),
                request: ms('5m'),
            },
            agent: {
                https: new HttpsAgent({
                    keepAlive: true,
                }),
            },
            hooks: {
                beforeRequest: [
                    async (options) => {
                        const url = options.url;
                        if (!url)
                            return;
                        if (typeof url === 'string') {
                            if (whiteListDomain.some((domain) => {
                                return url.includes(domain);
                            })) {
                                options.headers.authorization = `Bearer ${await this.tokenManager.getToken()}`;
                            }
                        }
                        else if (whiteListDomain.some((domain) => {
                            return url.hostname.includes(domain);
                        })) {
                            options.headers.authorization = `Bearer ${await this.tokenManager.getToken()}`;
                        }
                    },
                ],
            },
        });
        this.storage = getStorage(config);
    }
    get port() {
        return this._port;
    }
    async init() {
        await this.storage.init?.();
        if (config.enableUpnp) {
            await setupUpnp(config.port, config.clusterPublicPort);
        }
    }
    async getFileList(lastModified) {
        return { files: await this.got("mcim/all_files").json() };
    }
    async getConfiguration() {
        const res = await this.got.get('openbmclapi/configuration', {
            responseType: 'json',
            cache: this.requestCache,
        });
        return OpenbmclapiAgentConfigurationSchema.parse(res.body);
    }
    async syncFiles(fileList, syncConfig) {
        this.files = (await this.getFileList()).files;
    }
    setupExpress(https) {
        const app = http2Express(express);
        app.enable('trust proxy');
        const requestHuman = got.extend({
            headers: {
                'user-agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36",
            }
        });
        app.get('/auth', AuthRouteFactory(config));
        if (!config.disableAccessLog) {
            app.use(morgan('combined'));
        }
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        app.get('/download/:hash(\\w+)', async (req, res, next) => {
            try {
                const hash = req.params.hash.toLowerCase();
                const signValid = checkSign(hash, this.clusterSecret, req.query);
                if (!signValid) {
                    return res.status(403).send('invalid sign');
                }
                if (this.files.some((file) => file.hash === hash)) {
                    const file = this.files.find((file) => file.hash === hash);
                    const response = await requestHuman(file.url);
                    const buffer = response.rawBody;
                    res.setHeader('Content-Type', 'application/octet-stream');
                    res.setHeader('x-bmclapi-hash', hash);
                    res.status(200).send(buffer);
                    this.counters.bytes += file.size;
                    this.counters.hits += 1;
                }
            }
            catch (err) {
                if (err instanceof HTTPError) {
                    if (err.response.statusCode === 404) {
                        return next();
                    }
                }
                return next(err);
            }
        });
        app.use('/measure', MeasureRouteFactory(config));
        let server;
        if (https) {
            server = createSecureServer({
                key: readFileSync(join(this.tmpDir, 'key.pem'), 'utf8'),
                cert: readFileSync(join(this.tmpDir, 'cert.pem'), 'utf8'),
                allowHTTP1: true,
            }, app);
        }
        else {
            server = createServer(app);
        }
        this.server = server;
        return server;
    }
    async setupNginx(pwd, appPort, proto) {
        this._port = '/tmp/openbmclapi.sock';
        await rm(this._port, { force: true });
        const dir = await mkdtemp(join(tmpdir(), 'openbmclapi'));
        const confFile = `${dir}/nginx/nginx.conf`;
        const templateFile = 'nginx.conf';
        const confTemplate = await readFile(join(__dirname, '..', 'nginx', templateFile), 'utf8');
        console.log('nginx conf', confFile);
        await fse.copy(join(__dirname, '..', 'nginx'), dirname(confFile), { recursive: true, overwrite: true });
        await fse.outputFile(confFile, template(confTemplate)({
            root: pwd,
            port: appPort,
            ssl: proto === 'https',
            sock: this._port,
            user: userInfo().username,
            tmpdir: this.tmpDir,
        }));
        const logFile = join(__dirname, '..', 'access.log');
        const logFd = await open(logFile, 'a');
        await fse.ftruncate(logFd.fd);
        this.nginxProcess = spawn('nginx', ['-c', confFile], {
            stdio: [null, logFd.fd, 'inherit'],
        });
        await delay(ms('1s'));
        if (this.nginxProcess.exitCode !== null) {
            throw new Error(`nginx exit with code ${this.nginxProcess.exitCode}`);
        }
        const tail = new Tail(logFile);
        if (!config.disableAccessLog) {
            tail.on('line', (line) => {
                process.stdout.write(line);
                process.stdout.write('\n');
            });
        }
        // eslint-disable-next-line max-len
        const logRegexp = /^(?<client>\S+) \S+ (?<userid>\S+) \[(?<datetime>[^\]]+)] "(?<method>[A-Z]+) (?<request>[^ "]+)? HTTP\/[0-9.]+" (?<status>[0-9]{3}) (?<size>[0-9]+|-) "(?<referrer>[^"]*)" "(?<useragent>[^"]*)"/;
        tail.on('line', (line) => {
            const match = line.match(logRegexp);
            if (!match) {
                logger.debug(`cannot parse nginx log: ${line}`);
                return;
            }
            this.counters.hits++;
            this.counters.bytes += parseInt(match.groups?.size ?? '0', 10) || 0;
        });
        this.interval = setInterval(() => {
            void fse.ftruncate(logFd.fd);
        }, ms('60s'));
    }
    async listen() {
        await new Promise((resolve) => {
            if (!this.server) {
                throw new Error('server not setup');
            }
            this.server.listen(this._port, resolve);
        });
    }
    connect() {
        if (this.socket?.connected)
            return;
        this.socket = connect(this.prefixUrl, {
            transports: ['websocket'],
            auth: (cb) => {
                this.tokenManager
                    .getToken()
                    .then((token) => {
                    cb({ token });
                })
                    .catch((e) => {
                    logger.error(e, 'get token error');
                    this.exit(1);
                });
            },
        });
        this.socket.on('error', this.onConnectionError.bind(this, 'error'));
        this.socket.on('message', (msg) => {
            logger.info(msg);
        });
        this.socket.on('connect', () => {
            logger.debug('connected');
        });
        this.socket.on('disconnect', (reason) => {
            logger.warn(`与服务器断开连接: ${reason}`);
            this.isEnabled = false;
            this.keepalive.stop();
        });
        this.socket.on('exception', (err) => {
            logger.error(err, 'exception');
        });
        this.socket.on('warden-error', (data) => {
            logger.warn(data, '主控回报巡检异常');
        });
        const io = this.socket.io;
        io.on('reconnect', (attempt) => {
            logger.info(`在重试${attempt}次后恢复连接`);
            if (this.wantEnable) {
                logger.info('正在尝试重新启用服务');
                this.enable()
                    .then(() => logger.info('重试连接并且准备就绪'))
                    .catch(this.onConnectionError.bind(this, 'reconnect'));
            }
        });
        io.on('reconnect_error', (err) => {
            logger.error(err, 'reconnect_error');
        });
        io.on('reconnect_failed', this.onConnectionError.bind(this, 'reconnect_failed', new Error('reconnect failed')));
    }
    async enable() {
        if (this.isEnabled)
            return;
        logger.trace('enable');
        await this._enable();
        this.isEnabled = true;
        this.wantEnable = true;
    }
    async disable() {
        if (!this.socket)
            return;
        this.keepalive.stop();
        this.wantEnable = false;
        const [err, ack] = (await this.socket.emitWithAck('disable', null));
        this.isEnabled = false;
        if (err) {
            if (typeof err === 'object' && 'message' in err) {
                throw new Error(err.message);
            }
        }
        if (!ack) {
            throw new Error('节点禁用失败');
        }
        this.socket?.disconnect();
    }
    async requestCert() {
        if (!this.socket)
            throw new Error('未连接到服务器');
        const [err, cert] = (await this.socket.emitWithAck('request-cert'));
        if (err) {
            if (typeof err === 'object' && 'message' in err) {
                throw new Error(err.message);
            }
            else {
                throw new Error('请求证书失败', { cause: err });
            }
        }
        await fse.outputFile(join(this.tmpDir, 'cert.pem'), cert.cert);
        await fse.outputFile(join(this.tmpDir, 'key.pem'), cert.key);
    }
    exit(code = 0) {
        if (this.nginxProcess) {
            this.nginxProcess.kill();
        }
        // eslint-disable-next-line n/no-process-exit
        process.exit(code);
    }
    async _enable() {
        let err;
        let ack;
        if (!this.socket) {
            throw new Error('未连接到服务器');
        }
        try {
            const res = (await this.socket.timeout(ms('5m')).emitWithAck('enable', {
                host: this.host,
                port: this.publicPort,
                version: this.version,
                byoc: config.byoc,
                noFastEnable: process.env.NO_FAST_ENABLE === 'true',
                flavor: config.flavor,
            }));
            if (Array.isArray(res)) {
                ;
                [err, ack] = res;
            }
        }
        catch (e) {
            throw new Error('节点注册超时', { cause: e });
        }
        if (err) {
            if (typeof err === 'object' && 'message' in err) {
                throw new Error(err.message);
            }
        }
        if (ack !== true) {
            throw new Error('节点注册失败');
        }
        logger.info(colors.rainbow('start doing my job'));
        this.keepalive.start(this.socket);
    }
    onConnectionError(event, err) {
        console.error(`${event}: cannot connect to server`, err);
        if (this.server) {
            this.server.close(() => {
                this.exit(1);
            });
        }
        else {
            this.exit(1);
        }
    }
}
//# sourceMappingURL=cluster.js.map