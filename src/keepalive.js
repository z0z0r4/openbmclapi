import Bluebird from 'bluebird';
import { clone } from 'lodash-es';
import ms from 'ms';
import { clearTimeout } from 'node:timers';
import pTimeout from 'p-timeout';
import prettyBytes from 'pretty-bytes';
import { logger } from './logger.js';
export class Keepalive {
    interval;
    cluster;
    timer;
    socket;
    keepAliveError = 0;
    constructor(interval, cluster) {
        this.interval = interval;
        this.cluster = cluster;
    }
    start(socket) {
        this.socket = socket;
        this.schedule();
    }
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
    }
    schedule() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            logger.trace('start keep alive');
            void this.emitKeepAlive();
        }, this.interval);
    }
    async emitKeepAlive() {
        try {
            const status = await pTimeout(this.keepAlive(), {
                milliseconds: ms('10s'),
            });
            if (!status) {
                logger.fatal('kicked by server');
                return await this.restart();
            }
            this.keepAliveError = 0;
        }
        catch (e) {
            this.keepAliveError++;
            logger.error(e, 'keep alive error');
            if (this.keepAliveError >= 3) {
                await this.restart();
            }
        }
        finally {
            void this.schedule();
        }
    }
    async keepAlive() {
        if (!this.cluster.isEnabled) {
            throw new Error('节点未启用');
        }
        if (!this.socket) {
            throw new Error('未连接到服务器');
        }
        const counters = clone(this.cluster.counters);
        const [err, date] = (await this.socket.emitWithAck('keep-alive', {
            time: new Date(),
            ...counters,
        }));
        if (err)
            throw new Error('keep alive error', { cause: err });
        const bytes = prettyBytes(counters.bytes, { binary: true });
        logger.info(`keep alive success, serve ${counters.hits} files, ${bytes}`);
        this.cluster.counters.hits -= counters.hits;
        this.cluster.counters.bytes -= counters.bytes;
        return !!date;
    }
    async restart() {
        await Bluebird.try(async () => {
            await this.cluster.disable();
            this.cluster.connect();
            await this.cluster.enable();
        })
            .timeout(ms('10m'), 'restart timeout')
            .catch((e) => {
            logger.error(e, 'restart failed');
            this.cluster.exit(1);
        });
    }
}
//# sourceMappingURL=keepalive.js.map