'use strict';

// Simple and configurable map and reduce dataflow transforms

const { each, extend, filter, find, last, map, memoize, object, omit, pairs, pick, reduce, rest, uniq, zip } =
  require('underscore');
const url = require('url');

const audit = require('abacus-audit');
const batch = require('abacus-batch');
const breaker = require('abacus-breaker');
const dbclient = require('abacus-dbclient');
const dbCommons = require('abacus-dbcommons');
const dedupe = require('abacus-dedupe');
const lockcb = require('abacus-lock');
const moment = require('abacus-moment');
const oauth = require('abacus-oauth');
const partition = require('abacus-partition');
const retry = require('abacus-retry');
const request = require('abacus-request');
const router = require('abacus-router');
const seqid = require('abacus-seqid');
const throttle = require('abacus-throttle');
const transform = require('abacus-transform');
const urienv = require('abacus-urienv');
const vcapenv = require('abacus-vcapenv');
const yieldable = require('abacus-yieldable');

const tmap = yieldable(transform.map);
const treduce = yieldable(transform.reduce);

// Return the configured number of retries
const retries = process.env.SINK_RETRIES ? parseInt(process.env.SINK_RETRIES) : 5;

// if a batch is throttled then, throttle limits the number of calls made to
// the batch function limiting the number of batches. In order to avoid that
// all the batch functions when throttled should have a throttle value that is
// multiplied by the batch.
const brequest = yieldable(throttle(retry(breaker(batch(request)), retries),
  batch.defaults().maxSize * throttle.defaults().maxCalls));

const lock = yieldable(lockcb.locker('dataflow'));

/* eslint camelcase: 1 */

// Setup debug log
const debug = require('abacus-debug')('abacus-dataflow');
const edebug = require('abacus-debug')('e-abacus-dataflow');
const odebug = require('abacus-debug')('o-abacus-dataflow');

// Resolve service URIs
const uris = memoize(() =>
  urienv({
    db_uri: 'mongodb://localhost:27017'
  }, {
    skipMissing: true
  })
);

const forward = (n) => partition.createForwardFn(n, 4000);

// Return the configured number of db partitions to use
const dbpartitions = (n) => n ? n : process.env.DB_PARTITIONS ? parseInt(process.env.DB_PARTITIONS) : 1;

// Assemble bucket, period, forward and balance conversion functions into
// a custom db partitioning function
const dbpartition = (n) =>
  partition.partitioner(partition.bucket, partition.period, forward(dbpartitions(n)), partition.balance);

// Assemble bucket, period, forward and balance conversion functions into
// a custom sink partitioning function
const sinkpartition = (n) => {
  const sp = n ? n : process.env.SINK_APPS ? parseInt(process.env.SINK_APPS) : 1;
  return sp > 1
    ? partition.partitioner(partition.bucket, partition.period, forward(sp), partition.balance)
    : partition.nopartition;
};

// Return a handle to a db
const dbhandle = (dbserver, name) => dbclient(dbpartition(), dbclient.dburi(dbserver, name));

// Return a doc location given a route template and params
const loc = (req, path, id) => {
  if (!path || !id) return undefined;

  // List parameters from the path and the corresponding components
  // of the doc key
  const kk = filter(request.params(path), (n) => /^k/.test(n));
  const kv = dbclient.k(id).split('/');
  const tk = filter(request.params(path), (n) => /^t/.test(n));
  const tv = dbclient.t(id).split('/');

  const l =
    (req ? req.protocol + '://' + req.headers.host + (req.baseUrl || '') : 'http://localhost:9080') +
    request.route(path, extend(object(zip(kk, kv)), object(zip(tk, tv))));
  return l;
};

// Convert a type to an id field name
const idname = (type) => type + '_id';

// Report a duplicate output doc
const dupError = (oid) => {
  debug('Duplicate output doc %s', oid);
  return extend(new Error('Duplicate document update conflict'), {
    id: oid,
    status: 409,
    error: 'conflict',
    reason: 'Duplicate document update conflict',
    noretry: true,
    nobreaker: true
  });
};

// Detect duplicate output doc
const detectDup = function*(oid, ddup, odb) {
  debug('Checking for duplicate output doc %s', oid);

  if (ddup.has(oid))
    throw dupError(oid);

  debug('May be a duplicate output doc %s', oid);
  if (odb) {
    const odoc = yield odb.get(oid);
    if (odoc !== undefined) throw dupError(oid);
  } else debug('Not a duplicate output doc %s', oid);
};

// Add output doc id to duplicate filter
const filterDup = (oid, ddup) => {
  ddup.add(oid);
};

// Log an input doc
const logInput = function*(idoc, idb) {
  debug('Logging input doc %s', idoc.id);
  // Since database put may be retried on failure, there are fair chances that
  // we might receive a 409 when database write is successful the previous call
  try {
    yield idb.put(idoc);
  } catch (e) {
    if (e.status !== 409) throw e;
  }

  debug('Logged input doc %o', idoc);
};

// Retrieve the last accumulated output for a given input doc
const lastAccum = function*(okey, otime, odb) {
  const t = parseInt(otime);
  const eid = dbclient.kturi(okey, moment.utc(t).startOf('month').valueOf());
  const sid = dbclient.kturi(okey, moment.utc(t).endOf('month').valueOf()) + 'ZZZ';

  debug('Retrieving latest accumulated output between %s and %s', eid, sid);
  const odocs = yield odb.allDocs({
    endkey: eid,
    startkey: sid,
    descending: true,
    limit: 1,
    include_docs: true
  });
  if (!odocs || !odocs.rows.length) {
    debug('No existing accumulated output doc since %s', eid);
    return undefined;
  }
  odebug('Retrieved accumulated output doc id %s, rev %s, %o', odocs.rows[0].doc.id, odocs.rows[0].doc.rev);
  debug(
    'Retrieved accumulated output doc id %s, rev %s, %o',
    odocs.rows[0].doc.id,
    odocs.rows[0].doc.rev,
    odocs.rows[0].doc
  );
  return dbclient.undbify(
    extend({}, odocs.rows[0].doc, {
      rev: odocs.rows[0].doc._rev
    })
  );
};

// Return the URI of the sink service to post usage to
const sink = function*(id, shost, spartition) {
  // Compute the target sink partition
  const sinkp = yieldable(
    typeof spartition === 'function'
      ? spartition()
      : spartition !== undefined ? sinkpartition(parseInt(spartition)) : sinkpartition()
  );
  const p = yield sinkp(dbclient.k(id), dbclient.t(id), 'write');
  debug('Target sink host %s, partition %o', shost, p);

  // If there's no partitioning just return the configured sink host
  if (!p) return shost;

  // Map the sink host the URI of the app allocated to the target partition
  const u = url.parse(shost);
  const t = {};
  t.protocol = u.protocol;
  if (u.port) {
    // Add the partition number to the sink host port number
    t.port = parseInt(u.port) + parseInt(p[0]);
    t.hostname = u.hostname;
    debug('Mapping partition %o to port %s', p, u.port);
  } else {
    // Add the partition number to the sink host name
    t.host = u.host.replace(/([^.]+)(.*)/, '$1-' + p[0] + '$2');
    debug('Mapping partition %o to hostname %s', p, u.host);
  }

  // Format the target sink URI
  const surl = url.format(t);
  debug('Target sink uri %s, partition %o', surl, p);
  return surl;
};

// Report a post error
const postError = (oid, res) => {
  debug('Post error, doc %s, response %o', oid, res);
  return extend(
    {},
    {
      id: oid,
      status: res.statusCode
    },
    res.body || {}
  );
};

// Build a list of output docs
const buildOutputs = (itype, idoc, itime, otype, odocs, okeys, otimes, now) => {
  return map(odocs, (odoc, i, l) => {
    return extend({}, odoc, idoc.id ? object([[idname(itype), idoc.id]]) : {}, {
      id: dbclient.kturi(okeys[i], otimes[i]),
      processed_id: seqid.pad16(now),
      processed: parseInt(now)
    });
  });
};

// Post an output doc to the configured sink service
const postOutput = function*(odoc, skey, stime, shost, spartition, spost, authentication, ddup) {
  // Only post docs that have a post uri configured for them
  if (!spost) {
    debug('Skipping post of output doc %s to sink', odoc.id);
    return {
      statusCode: 201
    };
  }

  const sid = dbclient.kturi(skey, stime);
  const phost = yield sink(sid, shost, spartition);

  debug('Posting output doc %s to %s', odoc.id, phost + spost);
  try {
    const res = yield brequest.post(
      phost + spost,
      extend(
        authentication ? { headers: { authorization: authentication() } } : {},
        { body: omit(odoc, 'rev') }
      )
    );

    // Report sink service status. Allow sink duplicate to go through normally.
    // When an app has no duplicate detection (i.e. collector), throw the 409
    if (
      (res.statusCode !== 201 && res.statusCode !== 409) ||
      (res.statusCode === 409 && ((res.body && res.body.error === 'slack') || !ddup))
    )
      throw postError(odoc.id, res);

    debug('Posted %s successfully to sink', odoc.id);

    return res;
  } catch (exc) {
    edebug('Exception posting %s to sink, %o', odoc.id, exc);
    debug('Exception posting %s to sink, %o', odoc.id, exc);
    throw exc;
  }
};

// Post a list of output docs to the configured sink service
const postOutputs = function*(odocs, skeys, stimes, shost, spartition, sposts, authentication, ddup) {
  // Post each docs to the sink.
  const responses = yield tmap(odocs, function*(odoc, i, l) {
    return yield postOutput(odoc, skeys[i], stimes[i], shost, spartition, sposts[i], authentication, ddup);
  });

  debug('Checking results of post to sink');

  // Compile any errors other than duplicate returned from the sink
  const ereasons = reduce(
    responses,
    (a, response) => {
      debug('post returns %o', response);
      return response.statusCode !== 409 && response.body && response.body.error ? a.concat(response.body) : a;
    },
    []
  );

  // return errors if one is found from the sink
  return ereasons.length ? { error: 'esink', reason: ereasons } : undefined;
};

// Log an output doc
const logOutput = function*(odoc, odb) {
  odebug('Logging output doc %s, rev %s', odoc.id, odoc.rev);
  debug('Logging output doc %s, rev %s', odoc.id, odoc.rev);
  try {
    const res = yield odb.put(
      odoc.rev
        ? extend({}, omit(odoc, 'rev'), { _rev: odoc.rev })
        : odoc
    );
    odoc.rev = res.rev;
  } catch (err) {
    odebug('Error logging output doc %s, rev %s, %o', odoc.id, odoc.rev, err);
    debug('Error logging output doc %s, rev %s, %o', odoc.id, odoc.rev, err);
    throw err;
  }
  odebug('Logged new output doc %s, rev %s', odoc.id, odoc.rev);
  debug('Logged output doc %s, rev %s, %o', odoc.id, odoc.rev, odoc);
};

// Find the first occurence of error in the list of docs.
const checkError = (odocs) => {
  const error = find(odocs, (odoc) => odoc.error);
  // When there is an error in any of the docs, return the first
  // encountered error.
  if (error) {
    debug('Document has error %o', error);
    let result = {
      error: error.error,
      reason: error.reason
    };
    if (error.cause)
      result = extend(result, {
        cause: error.cause
      });
    return result;
  }

  return undefined;
};

// Log a list of output docs
const logOutputs = function*(odocs, odb) {
  const ids = map(odocs.concat([]).reverse(), (doc) => pick(doc, 'id', 'rev'));
  odebug('Logging output docs %o', ids);
  debug('Logging output docs %o', ids);

  // Find unique docs by id, as we only want the last version of each doc
  yield tmap(uniq(odocs.concat([]).reverse(), (doc) => doc.id), function*(odoc, i, l) {
    // Log each doc into the output database
    yield logOutput(odoc, odb);
  });
};

// Log an error doc
const logError = function*(edoc, edb) {
  debug('Logging error doc %s', edoc.id);
  yield edb.put(edoc);
  debug('Logged error doc %o', edoc);
};

// Compute the size of a db call, this is used to control the max size
// of a batch of calls to the db, which is set to a default of 100
const dbcsize = (name, args) => {
  // Batch 100 (100 * size 1) gets
  if (name === `${dbclient.name}.batch_get`) return 1;
  // Batch approx 1Mb of put, 1 represents 10K of put payload
  if (name === `${dbclient.name}.batch_put`) return Math.max(Math.floor(JSON.stringify(args[0]).length / 10240), 1);
  // Batch 100 (100 * size 1) of any other calls
  return 1;
};

// Return a configured db name
const dbname = (key, def) => {
  const env = process.env[key];
  if (env) return env === 'false' || env === '' ? undefined : env;
  return def;
};

// Return a db
const db = (dbname, dbh, dburi) => {
  const uri = dburi || uris().db_uri;
  debug('Getting db for name %s and uri %s', dbname, uri);

  if (!uri) {
    const msg = 'Missing DB configuration: provide DB_URI environment variable!';
    edebug(msg);
    throw new Error(msg);
  }

  return !dbname
    ? undefined
    : yieldable(throttle(retry(breaker(batch((dbh || dbhandle)(uri, dbname), 20, 100, dbcsize)))));
};

// Return a function that will convert a (bucket, period, op) to a list of
// (partition, epoch) pairs. This version of the forward function is used
// to target the dbs assigned to n
const iforward = (n) => (b, p, o, cb) => {
  const m = moment.toYYYYMM(p);

  // Use n partitions, one epoch per month, assume that each partition
  // supports all operations, and a single db per partition
  return cb(undefined, [[n, m]]);
};

// Assemble bucket, period, forward and balance conversion functions into
// the custom db partitioning function used to target the input db assigned
// to n
const idbpartition = (n) => partition.partitioner(partition.bucket, partition.period, iforward(n), partition.balance);

// Return a handle to the error db
const edbhandle = (dbserver, name) => dbclient(idbpartition(0), dbclient.dburi(dbserver, name));

// Return an errordb
const errordb = (dbname, dbh) =>
  !dbname
    ? undefined
    : yieldable(throttle(retry(breaker(batch((dbh || edbhandle)(uris().db_uri, dbname), 20, 100, dbcsize)))));

// Error list time limit (1 month)
const errorTimeLimit = 2629746000;

const getAuthorization = (req) => req && req.headers && req.headers.authorization;

const assureReadAuthorized = (cfg, req, doc) => {
  if (!cfg.rscope) return;
  oauth.authorize(getAuthorization(req), cfg.rscope(doc));
};

const assureWriteAuthorized = (cfg, req, doc) => {
  if (!cfg.wscope) return;
  oauth.authorize(getAuthorization(req), cfg.wscope(doc));
};

const assureDeleteAuthorized = (cfg, req) => {
  if (!cfg.dscope) return;
  oauth.authorize(getAuthorization(req), cfg.dscope());
};

const requestParamPairs = (req) => pairs(req.params);

const findRequestParams = (req, predicate) => filter(requestParamPairs(req), (pair) => predicate(pair[0]));

const requestParam = (req, predicate) => map(findRequestParams(req, predicate), (pair) => pair[1]).join('/');

const requestKeyParam = (req) => requestParam(req, (name) => /^k/.test(name));

const requestTimeParam = (req) => requestParam(req, (name) => /^t/.test(name));

const requestStartParam = (req) => requestParam(req, (name) => /^tstart/.test(name));

const requestEndParam = (req) => requestParam(req, (name) => /^tend/.test(name));

// A document could have an error with status or statusCode
// error could be expressionError (from eval), timeoutError (from eval)
const getStatusCode = (played) => {
  if (played.error) {
    const err = played.error;
    if (err.expressionError) {
      edebug('Get status code resolved to 422');
      return 422;
    }
    if (err.timeoutError) {
      edebug('Get status code resolved to 500');
      return 500;
    }
    if (err.status) {
      edebug(`Get status code resolved to ${err.status}`);
      return err.status;
    }
    if (err.statusCode) {
      edebug(`Get status code resolved to ${err.statusCode}`);
      return err.statusCode;
    }

    edebug('Get status code defaults to 500');
    return 500;
  }
  return 201;
};

const buildPlayResponse = (req, opt, played) => extend(
  {
    statusCode: getStatusCode(played),
    header: {
      Location: loc(req, opt.input.get, played.doc.id)
    }
  },
  played.error ? { body: played.error } : {}
);

// Group and reduce a batch of input docs sharing the same group keys
const groupReduce = (itype, yreducefn, otype, odb, shost, spartition, sposts, ddup) => {
  return yieldable(
    batch(
      batch.groupBy(
        function*(calls) {
          debug('Reducing a group of %d input docs with group key %s', calls.length, calls[0][0].igroups.join('/'));

          // Lock the input group
          const unlock = yield lock(calls[0][0].igroups[0]);
          try {
            // Read the last accumulated outputs produced for the given input
            const accums = yield tmap(zip(calls[0][0].okeys, calls[0][0].otimes), function*(kts, i, l) {
              if (!odb) return {};
              return yield lastAccum(kts[0], kts[1], odb);
            });

            // Apply the reduction function to each input doc in the batch
            const idocs = map(calls, (call) => call[0].idoc);
            debug('Calling group reduction with accums %o and input docs %o', accums, idocs);

            const ologs = yield treduce(
              idocs,
              function*(log, udoc, i, l) {
                const res = yield yreducefn(last(log), udoc);
                each(res, (r) => {
                  r.processed = parseInt(udoc.processed_id);
                });
                return log.concat([res]);
              },
              [accums]
            );
            const gdocs = rest(ologs);

            debug('Output docs from group reduce function %o', gdocs);

            // Build the final output docs
            const pgdocs = map(gdocs, (odocs, i, l) => {
              const podocs = buildOutputs(
                itype,
                calls[i][0].idoc,
                calls[i][0].itime,
                otype,
                odocs,
                calls[i][0].okeys,
                calls[i][0].otimes,
                moment.now()
              );
              debug(
                'Processed input doc %s, produced output docs %o',
                calls[i][0].idoc.id,
                map(podocs, (podoc) => podoc.id)
              );
              return podocs;
            });

            // Post the output docs to the configured sink
            const presults = yield tmap(pgdocs, function*(podocs, i, l) {
              const error = checkError(podocs);
              if (error) return error;

              if (!shost || !sposts) return undefined;

              return yield postOutputs(
                podocs,
                calls[i][0].skeys,
                calls[i][0].stimes,
                shost,
                spartition,
                sposts,
                calls[i][0].authentication,
                ddup
              );
            });

            // Find any errors in the post results
            const errors = filter(presults, (res) => res !== undefined);

            // Only log and cache the output docs if all posts have succeeded
            if (odb && !errors.length) {
              // Build final list of output docs to log
              const allpodocs = reduce(
                pgdocs,
                (allpodocs, podocs) => {
                  return allpodocs.concat(
                    map(podocs, (podoc, i) => {
                      if (accums[i] && accums[i].id === podoc.id) {
                        // Reuse the revision of the previous accumulator doc, as
                        // we're updating it with the reduction result doc
                        odebug('Logging reduction output as an update %s, rev %s', podoc.id, accums[i].rev);
                        debug('Logging reduction output as an update %s, rev %s', podoc.id, accums[i].rev);
                        podoc.rev = accums[i].rev;
                        return podoc;
                      }

                      // Reset revision in the reduction result doc, as we're
                      // storing it as a new doc
                      odebug('Logging reduction output as a new doc %s', podoc.id);
                      debug('Logging reduction output as a new doc %s', podoc.id);
                      delete podoc.rev;
                      return podoc;
                    })
                  );
                },
                []
              );

              // Log all the output docs
              yield logOutputs(allpodocs, odb);
            }

            return map(presults, (res) => [null, res]);
          } catch (err) {
            edebug('Reduce error %o', err);
            throw err;
          } finally {
            unlock();
          }
        },
        function*(call) {
          return call[0].igroups.join('/');
        }
      )
    )
  );
};

// Return an Express router that provides a REST API to a dataflow reduce
// transform service
const reducer = (reducefn, opt) => {
  // Configure dbs for input, output and error docs
  const idb = db(dbname('INPUT_DB', opt.input.dbname), opt.input.dbhandle);
  const odb = db(dbname('OUTPUT_DB', opt.output.dbname), opt.output.dbhandle);
  const edb = errordb(dbname('ERROR_DB', opt.error && opt.error.dbname));

  // Create a duplicate doc filter
  const ddup = opt.input.dedupe === false || opt.input.dedupe === 0 ? undefined : dedupe();

  // Convert the reduce function to a yieldable
  const yreducefn = yieldable(reducefn);

  // Configure our batch grouping reduction function
  const greduce = groupReduce(
    opt.input.type,
    yreducefn,
    opt.output.type,
    odb,
    opt.sink.host,
    opt.sink.apps,
    opt.sink.posts,
    ddup
  );

  // Create an Express router
  const routes = router();

  // Reduce an input doc to an output doc, store both the input and output
  // and pass the output to the configured sink service
  /* eslint complexity: [1, 6] */
  const play = function*(idoc, auth) {
    debug('Reducing input doc %o', idoc);

    // Compute the input/output doc keys and times
    const ikey = opt.input.key(idoc, auth);
    const itime = opt.input.time(idoc);
    const okeys = opt.output.keys(idoc, ikey);
    const otimes = opt.output.times(idoc, itime);
    const skeys = (opt.sink.keys || opt.output.keys)(idoc, ikey);
    const stimes = (opt.sink.times || opt.output.times)(idoc, itime);

    // Generate ids for the input doc
    const playedInputDoc = extend(
      {},
      idoc,
      {
        id: dbclient.tkuri(ikey, itime),
        processed_id: seqid.pad16(itime),
        processed: idoc.processed || parseInt(itime)
      },
      idoc.id ? object([[idname(opt.input.type), idoc.id]]) : {}
    );

    // Serialize processing on leaf output doc id
    const oid = dbclient.kturi(last(okeys), last(otimes));
    const unlock = yield lock(oid);

    let error;
    try {
      // Check for duplicate output doc
      if (ddup) yield detectDup(oid, ddup, odb);

      // Log the input doc
      if (idb) yield logInput(playedInputDoc, idb);

      try {
        // Process the input doc, post output to sink and log it
        error = yield greduce({
          igroups: opt.input.groups(playedInputDoc),
          idoc: playedInputDoc,
          itime: itime,
          okeys: okeys,
          otimes: otimes,
          skeys: skeys,
          stimes: stimes,
          authorization: auth,
          authentication: opt.sink.authentication
        });
      } catch (err) {
        edebug('Error during reduce operation: %j', err);
        error = err;
      }

      // Add leaf output doc id to duplicate filter
      if (ddup && !error) filterDup(oid, ddup);

      // Log the input doc with the error attached
      if (edb && error) {
        const ekey = opt.error.key(idoc, auth);
        const etime = opt.error.time(idoc);
        const eid = dbclient.tkuri(ekey, etime);
        const doc = yield edb.get(eid);

        // Don't post duplicate error doc
        if (!doc) {
          const edoc = extend(
            {},
            idoc,
            {
              id: eid
            },
            error
          );
          yield logError(edoc, edb);
        }
      }
    } finally {
      unlock();
    }

    return {
      doc: playedInputDoc,
      error: error
    };
  };

  // Handle an input doc post, reduce it to an output doc, store both the
  // input and output and pass the output to the configured sink service
  routes.post(
    opt.input.post,
    throttle(function*(req) {
      const idoc = req.body;

      // Validate the input doc
      if (!idoc)
        return {
          statusCode: 400
        };
      if (opt.input.schema) opt.input.schema.validate(idoc);

      assureWriteAuthorized(opt.input, req, idoc);

      // Process the input doc
      const played = yield play(idoc, getAuthorization(req));

      // Return the input doc location
      return buildPlayResponse(req, opt, played);
    })
  );

  // Retrieve an input doc
  if (opt.input.get)
    routes.get(
      opt.input.get,
      throttle(function*(req) {
        const ks = requestKeyParam(req);
        const ts = requestTimeParam(req);
        const id = dbclient.tkuri(ks, ts);
        debug('Retrieving input doc for id %s', id);
        const doc = yield idb.get(id);
        if (!doc)
          return {
            statusCode: 404
          };

        assureReadAuthorized(opt.input, req, doc);

        return {
          body: dbclient.undbify(doc)
        };
      })
    );

  // Retrieve an output doc
  if (opt.output.get)
    routes.get(
      opt.output.get,
      throttle(function*(req) {
        const ks = requestKeyParam(req);
        const ts = requestTimeParam(req);
        const id = dbclient.kturi(ks, ts);
        debug('Retrieving output doc for id %s', id);
        const doc = yield odb.get(id);
        if (!doc)
          return {
            statusCode: 404
          };

        assureReadAuthorized(opt.output, req, doc);

        return {
          body: dbclient.undbify(doc)
        };
      })
    );

  // Retrieve error docs
  if (opt.error && opt.error.get)
    routes.get(
      opt.error.get,
      throttle(function*(req) {
        const start = requestStartParam(req);
        const end = requestEndParam(req);

        if (end - start > errorTimeLimit) {
          const msg = 'Cannot retrieve error docs older than ' + errorTimeLimit + ' milliseconds';
          throw extend(new Error(msg), {
            status: 409,
            error: 'errlimit',
            reason: msg,
            noretry: true,
            nobreaker: true
          });
        }

        debug('Retrieving error docs from %s to %s', start, end);

        // Get all error beginning of time to t in descending order
        const docs = yield edb.allDocs({
          startkey: dbclient.tkuri('', end),
          endkey: dbclient.tkuri('', start + 'Z'),
          descending: true,
          include_docs: true
        });

        assureReadAuthorized(opt.error, req, docs);

        return {
          body: map(docs.rows, (row) => {
            return dbclient.undbify(row.doc);
          })
        };
      })
    );

  // Delete an error doc
  if (opt.error && opt.error.delete)
    routes.delete(
      opt.error.delete,
      throttle(function*(req) {
        const ks = requestKeyParam(req);
        const ts = requestTimeParam(req);

        let client = 'unknown';
        const auth = getAuthorization(req);
        if (auth) {
          let authHeader = auth.replace(/^bearer /i, '');
          client = oauth.getUserInfo(authHeader);
        }

        assureDeleteAuthorized(opt.error, req);

        // Get doc from edb
        const id = dbclient.tkuri(ks, ts);
        debug('Retrieving error doc with id %s by client %o ...', id, client);
        const edoc = yield edb.get(id);

        if (!edoc)
          return {
            statusCode: 404
          };

        audit('Removing error doc %j by client %j ...', edoc, client);
        const status = yield edb.remove(edoc);
        audit('Delete status %j by client %j', status, client);

        return {
          body: status
        };
      })
    );

  // Return the router
  routes.play = play;
  routes.config = () => opt;

  return routes;
};

// Return a handle to the single input db assigned to this app instance
const idbhandle = (dbserver, name) =>
  dbclient(idbpartition(parseInt(vcapenv.appindex())), dbclient.dburi(dbserver, name));

// Return a db to use when replaying docs
const replaydb = (dbname, dbh) =>
  !dbname ? undefined : throttle(retry(breaker(batch((dbh || idbhandle)(uris().db_uri, dbname)))));

// Replay an input docs that doesn't have a corresponding output
const replayDoc = (odb, edb, routes) =>
  function*(stats, doc, i, l) {
    const idoc = dbclient.undbify(doc.doc);

    // Look for the ouput doc corresponding to an input doc
    debug('Checking output doc for input %s', idoc.id);
    const ikey = dbclient.k(idoc.id);
    const itime = dbclient.t(idoc.id);
    const opt = routes.config();
    const okeys = opt.output.keys(idoc, ikey);
    const otimes = opt.output.times(idoc, itime);
    const id = dbclient.kturi(last(okeys), last(otimes));
    debug('Output doc id is %s', id);
    const odoc = yield odb.get(id);

    // Found the output doc, no need to replay
    if (odoc) {
      debug('Found existing output doc for input %s', idoc.id);
      return stats;
    }

    // Check error doc
    if (edb) {
      const ekey = opt.error.key(idoc);
      const etime = opt.error.time(idoc);
      const errid = dbclient.tkuri(ekey, etime);
      const edoc = yield edb.get(errid);

      // Found the error doc, no need to replay
      if (edoc) {
        debug('Found existing error doc for input %s', idoc.id);
        return stats;
      }
    }

    // Replay the input doc
    try {
      debug('No existing output doc for input %s, replaying %o', idoc.id, idoc);
      const played = yield routes.play(
        omit(idoc, 'id', 'processed'),
        opt.input.authentication ? opt.input.authentication() : undefined
      );
      const rdoc = buildPlayResponse(undefined, opt, played);
      if (rdoc.statusCode === 201) {
        debug('Replayed input doc %s , new output %o', idoc.id, rdoc);
        stats.replayed++;
        return stats;
      }
    } catch (e) {
      debug('Error during input doc replay %o', e);
    }
    debug('Failed to replay input doc %s', idoc.id);
    stats.failed++;
    return stats;
  };

// Replay the input docs that don't have corresponding outputs
const replayAllDocs = (processingStats, routes) => (idocs, cb) => {
  yieldable.functioncb(function*() {
    const opt = routes.config();
    const odbName = dbname('OUTPUT_DB', opt.output.dbname);
    const odb = yieldable(replaydb(odbName, opt.output.dbhandle));
    const edbName = dbname('ERROR_DB', opt.error && opt.error.dbname);
    const edb = errordb(edbName);
    debug('Using output database %s and error database %s', odbName, edbName);

    const replayDocFn = replayDoc(odb, edb, routes);
    return yield treduce(idocs, replayDocFn, processingStats);
  })((err, stats) => {
    if (err) edebug('Error replaying input docs %o', err);
    else debug('Replayed input docs %o', stats);
    cb(err, stats);
  });
};

// Replay the last input docs that don't have any corresponding inputs.
// This is typically used when restarting a flow after an error.
const replay = (routes, twindow, cb) => {
  // Use the configured replay time
  const tw = parseInt(process.env.REPLAY) || twindow;
  if (!tw) {
    cb(undefined, []);
    return;
  }

  debug('Replaying last input docs from %d msec', tw);

  const opt = routes.config();
  const idbName = dbname('INPUT_DB', opt.input.dbname);
  const idb = replaydb(idbName, opt.input.dbhandle);
  debug('Using input database %s', idbName);

  // Retrieve the last input docs from the input db using a time
  // range db query back to the configured replay time
  const now = moment.now();
  const pagingOptions = {
    include_docs: true,
    startkey: ['t', seqid.pad16(now - tw)].join('/'),
    endkey: ['t', seqid.pad16(now)].join('/'),
    limit: process.env.PAGE_SIZE || 200
  };

  debug('Retrieving input docs with %o', pagingOptions);
  const returnDocs = {
    replayed: 0,
    failed: 0
  };
  const readAllPages = dbCommons().readAllPages;
  readAllPages(idb, pagingOptions, replayAllDocs(returnDocs, routes), (err) => {
    cb(err, returnDocs);
  });
};

// Export our public functions
module.exports.db = db;
module.exports.replaydb = replaydb;
module.exports.errordb = errordb;
module.exports.partition = dbpartition;
module.exports.reducer = reducer;
module.exports.replay = replay;
module.exports.sink = sink;
module.exports.logInput = logInput;
