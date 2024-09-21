import express from 'express';
import { checkSign } from '../util.js';
export default function MeasureRouteFactory(config) {
    const router = express.Router();
    const measureRoute = router;
    router.get('/:size(\\d+)', (req, res) => {
        const isSignValid = checkSign(req.baseUrl + req.path, config.clusterSecret, req.query);
        if (!isSignValid)
            return res.sendStatus(403);
        const size = parseInt(req.params.size, 10);
        if (isNaN(size) || size > 200)
            return res.sendStatus(400);
        const buffer = Buffer.alloc(1024 * 1024, '0066ccff', 'hex');
        res.set('content-length', (size * 1024 * 1024).toString());
        for (let i = 0; i < size; i++) {
            res.write(buffer);
        }
        res.end();
    });
    return measureRoute;
}
//# sourceMappingURL=measure.route.js.map