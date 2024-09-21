import { second } from '@bangbang93/utils';
import { createUpnpClient } from '@xmcl/nat-api';
import ms from 'ms';
import { logger } from './logger.js';
export async function setupUpnp(port, publicPort = port) {
    const client = await createUpnpClient();
    await doPortMap(client, port, publicPort);
    setInterval(() => {
        doPortMap(client, port, publicPort).catch((e) => {
            logger.error(e, 'upnp续期失败');
        });
    }, ms('30m'));
    return await client.externalIp();
}
async function doPortMap(client, port, publicPort) {
    await client.map({
        public: publicPort,
        private: port,
        ttl: second('1h'),
        protocol: 'tcp',
        description: 'openbmclapi',
    });
}
//# sourceMappingURL=upnp.js.map