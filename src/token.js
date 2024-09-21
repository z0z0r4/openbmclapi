import got from 'got';
import ms from 'ms';
import { createHmac } from 'node:crypto';
import { logger } from './logger.js';
export class TokenManager {
    clusterId;
    clusterSecret;
    token;
    got;
    prefixUrl = process.env.CLUSTER_BMCLAPI ?? 'https://openbmclapi.bangbang93.com';
    constructor(clusterId, clusterSecret, version) {
        this.clusterId = clusterId;
        this.clusterSecret = clusterSecret;
        this.got = got.extend({
            prefixUrl: this.prefixUrl,
            headers: {
                'user-agent': `openbmclapi-cluster/${version}`,
            },
            timeout: {
                request: ms('5m'),
            },
        });
    }
    async getToken() {
        if (!this.token) {
            this.token = await this.fetchToken();
        }
        return this.token;
    }
    async fetchToken() {
        const challenge = await this.got
            .get('openbmclapi-agent/challenge', {
            searchParams: {
                clusterId: this.clusterId,
            },
        })
            .json();
        const signature = createHmac('sha256', this.clusterSecret).update(challenge.challenge).digest('hex');
        const token = await this.got
            .post('openbmclapi-agent/token', {
            json: {
                clusterId: this.clusterId,
                challenge: challenge.challenge,
                signature,
            },
        })
            .json();
        this.scheduleRefreshToken(token.ttl);
        return token.token;
    }
    scheduleRefreshToken(ttl) {
        const next = Math.max(ttl - ms('10m'), ttl / 2);
        setTimeout(() => {
            this.refreshToken().catch((err) => {
                logger.error(err, 'refresh token error');
            });
        }, next);
        logger.trace(`schedule refresh token in ${next}ms`);
    }
    async refreshToken() {
        const token = await this.got
            .post('openbmclapi-agent/token', {
            json: {
                clusterId: this.clusterId,
                token: this.token,
            },
        })
            .json();
        logger.debug('success fresh token');
        this.scheduleRefreshToken(token.ttl);
        this.token = token.token;
    }
}
//# sourceMappingURL=token.js.map