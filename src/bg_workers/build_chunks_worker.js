'use strict';

module.exports = {
    background_worker: background_worker,
};

var P = require('../util/promise');
var db = require('../server/db');
var MapBuilder = require('../server/mapper/map_builder');
var dbg = require('../util/debug_module')(__filename);

/**
 *
 * BUILD_CHUNKS_WORKER
 *
 * background worker that scans chunks and builds them according to their blocks status
 *
 */
function background_worker() {
    var self = this;
    return P.fcall(function() {
            var now = Date.now();
            var query = {
                $and: [{
                    $or: [{
                        last_build: null
                    }, {
                        last_build: {
                            $lt: new Date(now - self.time_since_last_build)
                        }
                    }]
                }, {
                    $or: [{
                        building: null
                    }, {
                        building: {
                            $lt: new Date(now - self.building_timeout)
                        }
                    }]
                }]
            };
            if (self.last_chunk_id) {
                query._id = {
                    $lt: self.last_chunk_id
                };
            } else {
                dbg.log0('BUILD_WORKER:', 'BEGIN');
            }
            query.deleted = null;

            return P.when(db.DataChunk.find(query).limit(self.batch_size).sort('-_id').lean().exec());
            // return P.when(db.DataChunk.collection.find(query, {
            //     limit: self.batch_size,
            //     sort: {
            //         _id: -1
            //     }
            // }).toArray());
        })
        .then(function(chunks) {

            // update the last_chunk_id for next time
            if (chunks.length === self.batch_size) {
                self.last_chunk_id = chunks[0]._id;
            } else {
                self.last_chunk_id = undefined;
            }

            if (chunks.length) {
                dbg.log0('BUILD_WORKER:', 'WORKING ON', chunks.length, 'CHUNKS');
                let builder = new MapBuilder(chunks);
                return builder.run();
            }
        })
        .then(function() {
            // return the delay before next batch
            if (self.last_chunk_id) {
                dbg.log0('BUILD_WORKER:', 'CONTINUE', self.last_chunk_id);
                return 100;
            } else {
                dbg.log0('BUILD_WORKER:', 'END');
                return 60000;
            }
        }, function(err) {
            // return the delay before next batch
            dbg.error('BUILD_WORKER:', 'ERROR', err, err.stack);
            return 10000;
        });
}
