import { basename } from 'path';
import { checkSign } from '../util.js';
export function AuthRouteFactory(config) {
    return (req, res, next) => {
        try {
            const oldUrl = req.get('x-original-uri');
            if (!oldUrl)
                return res.status(403).send('invalid sign');
            const url = new URL(oldUrl, 'http://localhost');
            const hash = basename(url.pathname);
            const query = Object.fromEntries(url.searchParams.entries());
            const signValid = checkSign(hash, config.clusterSecret, query);
            if (!signValid) {
                return res.status(403).send('invalid sign');
            }
            res.sendStatus(204);
        }
        catch (e) {
            return next(e);
        }
    };
}
//# sourceMappingURL=auth.route.js.map