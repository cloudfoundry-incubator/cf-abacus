'use strict';

const dbclient = require('abacus-dbclient');
const moment = require('abacus-moment');
const lifecycleManager = require('abacus-lifecycle-manager')();

const fixture = require('./fixture');
const rabbitClient = require('./rabbit-client');
const createMeterDbClient = require('./meter-db-client');

const { extend, omit } = require('underscore');

const queueName = 'meter-itest-queue';
const mainExchange = 'meter-itest-main-exchange';
const firstDlName = 'meter-itest-first-dl';
const firstDlExchange = 'meter-itest-first-exchange';
const secondDlName = 'meter-itest-second-dl';
const secondDlExchange = 'meter-itest-second-exchange';
const { checkCorrectSetup } = require('abacus-test-helper');

const testEnv = {
  db: process.env.DB_URI || 'mongodb://localhost:27017',
  dbPartitions: 6
};

describe('meter integration test', () => {
  let stubs;
  let usage;
  let timestamp;
  let meterDbClient;

  before(async() => {
    checkCorrectSetup(testEnv);
    const modules = [lifecycleManager.modules.meter];
    const customEnv = extend({}, process.env, {
      DB_PARTITIONS: testEnv.dbPartitions,
      ABACUS_COLLECT_QUEUE: queueName,
      MAIN_EXCHANGE: mainExchange,
      FIRST_DL_NAME: firstDlName,
      FIRST_DL_EXCHANGE: firstDlExchange,
      FIRST_DL_TTL: 1000 * 5,
      FIRST_DL_RETRIES: 2,
      SECOND_DL_NAME: secondDlName,
      SECOND_DL_EXCHANGE: secondDlExchange,
      SECOND_DL_TTL: 1000 * 10,
      SECOND_DL_RETRIES: 2
    });

    // drop all abacus collections except plans and plan-mappings
    dbclient.drop(testEnv.db, /^abacus-((?!plan).)*$/, () => {
      lifecycleManager.useEnv(customEnv).startModules(modules);
    });

    meterDbClient = createMeterDbClient(testEnv.dbPartitions);
    await rabbitClient.deleteQueue(queueName);
    await rabbitClient.deleteQueue(firstDlName);
    await rabbitClient.deleteQueue(secondDlName);
  });

  after(() => {
    lifecycleManager.stopAllStarted();
  });

  afterEach(async() => {
    stubs.accumulator.reset();
    stubs.account.reset();
    stubs.provisioning.reset();

    await stubs.accumulator.close();
    await stubs.account.close();
    await stubs.provisioning.close();
  });

  const startApps = (stubs) => {
    stubs.provisioning.startApp(9880);
    stubs.account.startApp(9881);
    stubs.accumulator.startApp(9200);
  };

  const postUsage = async(usage) => {
    await rabbitClient.sendToQueue(queueName, usage);
  };

  const verifyStubCalls = (timestamp, callCount) => {
    expect(stubs.provisioning.getCallCount(fixture.provisioning.resourceTypeUrl.withDefaultParam(timestamp)))
      .to.equal(callCount);
    expect(stubs.account.getCallCount(fixture.account.url.withDefaultParams(timestamp))).to.equal(callCount);
    expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
      .withDefaultParams(timestamp, 'metering'))).to.equal(callCount);
    expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
      .withDefaultParams(timestamp, 'pricing'))).to.equal(callCount);
    expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
      .withDefaultParams(timestamp, 'rating'))).to.equal(callCount);
    expect(stubs.accumulator.getCallCount(fixture.accumulator.url)).to.equal(callCount);
  };

  const verifyDocStoredInDb = async(db, usageDoc) => {
    await eventually(async () => {
      const dbDoc = await db.get(usageDoc);
      expect(dbDoc).to.not.equal(undefined);
    });
  };

  context('on success', () => {
    before(async() => {
      timestamp = moment.now();
      usage = fixture.usageDoc({ time: timestamp });

      const config = {
        provisioning: fixture.provisioning.successfulResponses(timestamp),
        account: fixture.account.successfulResponses(timestamp),
        accumulator: fixture.accumulator.successfulResponses()
      };
      stubs = fixture.buildStubs(config);
      startApps(stubs);

      await postUsage(usage);
      await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
    });

    it('consumes messages', () => {
      verifyStubCalls(timestamp, 1);
    });

    it('output document is stored in output db', async() => {
      await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
    });
  });

  context('when accumulator fails', () => {
    before(async() => {
      timestamp = moment.now();
      usage = fixture.usageDoc({ time: timestamp });

      const config = {
        provisioning: fixture.provisioning.successfulResponses(timestamp),
        account: fixture.account.successfulResponses(timestamp),
        accumulator: [{
          url: fixture.accumulator.url,
          responses: [
            fixture.buildResponse(500),
            fixture.buildResponse(201, 'CREATED')
          ]
        }]
      };
      stubs = fixture.buildStubs(config);
      startApps(stubs);

      await postUsage(usage);
      await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(2);
    });

    it('retries the message once', () => {
      expect(stubs.accumulator.getCallCount(fixture.accumulator.url)).to.equal(2);
    });

    it('output document is stored in output db', async() => {
      await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
    });
  });

  context('when accumulator fails with non-retryable error', () => {
    before(async() => {
      timestamp = moment.now();
      usage = fixture.usageDoc({ time: timestamp });

      const config = {
        provisioning: fixture.provisioning.successfulResponses(timestamp),
        account: fixture.account.successfulResponses(timestamp),
        accumulator: [{
          url: fixture.accumulator.url,
          responses: [
            fixture.buildResponse(422),
            fixture.buildResponse(201, 'CREATED')
          ]
        }]
      };
      stubs = fixture.buildStubs(config);
      startApps(stubs);

      await postUsage(usage);
      await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
    });

    it('does not retry', () => {
      verifyStubCalls(timestamp, 1);
    });

    it('error document is stored in error db', async() => {
      await verifyDocStoredInDb(meterDbClient.error, usage.usageDoc);
    });
  });

  context('when provisioning fails', () => {
    context('when getting resource type fails', () => {
      before(async() => {
        timestamp = moment.now();
        usage = fixture.usageDoc({ time: timestamp });

        const config = {
          provisioning: [{
            url: fixture.provisioning.resourceTypeUrl.withDefaultParam(timestamp),
            responses: [
              fixture.buildResponse(500),
              fixture.provisioning.responses.successfulResourceType(timestamp)
            ]
          },
          {
            url: fixture.provisioning.pricingPlanUrl(timestamp),
            responses: [
              fixture.provisioning.responses.successfulPricingPlan
            ]
          }
          ],
          account: fixture.account.successfulResponses(timestamp),
          accumulator: fixture.accumulator.successfulResponses()
        };
        stubs = fixture.buildStubs(config);
        startApps(stubs);

        await postUsage(usage);
        await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      });

      it('retries the calls', () => {
        expect(stubs.provisioning.getCallCount(fixture.provisioning.resourceTypeUrl
          .withDefaultParam(timestamp))).to.equal(2);
      });

      it('output document is stored in output db', async() => {
        await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
      });
    });
  });

  context('when account fails', () => {
    context('when getting account fails', () => {
      before(async() => {
        timestamp = moment.now();
        usage = fixture.usageDoc({ time: timestamp });

        const config = {
          provisioning: fixture.provisioning.successfulResponses(timestamp),
          account: [
            {
              url: fixture.account.url.withDefaultParams(timestamp),
              responses: [
                fixture.buildResponse(500),
                fixture.account.responses.successfulGetAccount
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'metering'),
              responses: [
                fixture.account.responses.successfulGetMeteringPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'rating'),
              responses: [
                fixture.account.responses.successfulGetRatingPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'pricing'),
              responses: [
                fixture.account.responses.successfulGetPricingPlanIdResponse(timestamp)
              ]
            }

          ],
          accumulator: fixture.accumulator.successfulResponses()
        };
        stubs = fixture.buildStubs(config);
        startApps(stubs);

        await postUsage(usage);
        await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      });

      it('retries the calls', () => {
        expect(stubs.account.getCallCount(fixture.account.url.withDefaultParams(timestamp))).to.equal(2);
      });

      it('output document is stored in output db', async() => {
        await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
      });
    });

    context('when getting metering plan id fails', () => {
      before(async() => {
        timestamp = moment.now();
        usage = fixture.usageDoc({ time: timestamp });

        const config = {
          provisioning: fixture.provisioning.successfulResponses(timestamp),
          account: [
            {
              url: fixture.account.url.withDefaultParams(timestamp),
              responses: [
                fixture.account.responses.successfulGetAccount
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'metering'),
              responses: [
                fixture.buildResponse(500),
                fixture.account.responses.successfulGetMeteringPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'rating'),
              responses: [
                fixture.account.responses.successfulGetRatingPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'pricing'),
              responses: [
                fixture.account.responses.successfulGetPricingPlanIdResponse(timestamp)
              ]
            }
          ],
          accumulator: fixture.accumulator.successfulResponses()
        };
        stubs = fixture.buildStubs(config);
        startApps(stubs);

        await postUsage(usage);
        await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      });

      it('retries the calls', () => {
        expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
          .withDefaultParams(timestamp, 'metering'))).to.equal(2);
      });

      it('output document is stored in output db', async() => {
        await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
      });
    });

    context('when getting rating plan id fails', () => {
      before(async() => {
        timestamp = moment.now();
        usage = fixture.usageDoc({ time: timestamp });

        const config = {
          provisioning: fixture.provisioning.successfulResponses(timestamp),
          account: [
            {
              url: fixture.account.url.withDefaultParams(timestamp),
              responses: [
                fixture.account.responses.successfulGetAccount
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'metering'),
              responses: [
                fixture.account.responses.successfulGetMeteringPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'rating'),
              responses: [
                fixture.buildResponse(500),
                fixture.account.responses.successfulGetRatingPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'pricing'),
              responses: [
                fixture.account.responses.successfulGetPricingPlanIdResponse(timestamp)
              ]
            }
          ],
          accumulator: fixture.accumulator.successfulResponses()
        };
        stubs = fixture.buildStubs(config);
        startApps(stubs);

        await postUsage(usage);
        await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      });

      it('retries the calls', () => {
        expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
          .withDefaultParams(timestamp, 'rating'))).to.equal(2);
      });

      it('output document is stored in output db', async() => {
        await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
      });
    });

    context('when getting pricing plan id fails', () => {
      before(async() => {
        timestamp = moment.now();
        usage = fixture.usageDoc({ time: timestamp });

        const config = {
          provisioning: fixture.provisioning.successfulResponses(timestamp),
          account: [
            {
              url: fixture.account.url.withDefaultParams(timestamp),
              responses: [
                fixture.account.responses.successfulGetAccount
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'metering'),
              responses: [
                fixture.account.responses.successfulGetMeteringPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'rating'),
              responses: [
                fixture.account.responses.successfulGetRatingPlanIdResponse
              ]
            },
            {
              url: fixture.account.accountPluginGetPlanIdUrl.withDefaultParams(timestamp, 'pricing'),
              responses: [
                fixture.buildResponse(500),
                fixture.account.responses.successfulGetPricingPlanIdResponse(timestamp)
              ]
            }
          ],
          accumulator: fixture.accumulator.successfulResponses()
        };
        stubs = fixture.buildStubs(config);
        startApps(stubs);

        await postUsage(usage);
        await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      });

      it('retries the calls', () => {
        expect(stubs.account.getCallCount(fixture.account.accountPluginGetPlanIdUrl
          .withDefaultParams(timestamp, 'pricing'))).to.equal(2);
      });

      it('output document is stored in output db', async() => {
        await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);
      });
    });
  });

  context('when consuming duplicate message', () => {
    before(async() => {
      timestamp = moment.now();
      usage = fixture.usageDoc({ time: timestamp });

      const config = {
        provisioning: fixture.provisioning.successfulResponses(timestamp),
        account: fixture.account.successfulResponses(timestamp),
        accumulator: fixture.accumulator.successfulResponses()
      };
      stubs = fixture.buildStubs(config);
      startApps(stubs);

      await postUsage(usage);
      await stubs.accumulator.waitUntil.alias(fixture.accumulator.url).isCalled(1);
      verifyStubCalls(timestamp, 1);
      await verifyDocStoredInDb(meterDbClient.output, usage.usageDoc);

      await postUsage(usage);
    });

    it('queue should be empty', async() => {
      await eventually(async () => {
        const messagesCount = await rabbitClient.messagesCount(queueName, firstDlName, secondDlName);
        expect(messagesCount).to.equal(0);
      });
    });

    it('does not retry', () => {
      verifyStubCalls(timestamp, 0);
    });

    it('does not store in errordb', async() => {
      const dbDoc = await meterDbClient.error.get(usage.usageDoc);
      expect(dbDoc).to.equal(undefined);
    });
  });

  context('when consuming future message', () => {
    let usage;
    let nextDayTimestamp;
    let errorDbDoc;

    before(async() => {
      nextDayTimestamp = moment.utc().add(1, 'day').valueOf();
      const config = {
        provisioning: fixture.provisioning.successfulResponses(nextDayTimestamp),
        account: fixture.account.successfulResponses(nextDayTimestamp),
        accumulator: fixture.accumulator.successfulResponses()
      };
      usage = fixture.usageDoc({ time: nextDayTimestamp });
      stubs = fixture.buildStubs(config);
      startApps(stubs);

      await postUsage(usage);
      await eventually(async () => {
        errorDbDoc = await meterDbClient.error.get(usage.usageDoc);
        if(!errorDbDoc)
          throw new Error();
      });
    });

    it('stores message in error db', () => {
      const expectedErrorDbDoc = extend({}, usage, { error: { isFutureUsageError: true } });
      expect(omit(errorDbDoc, '_id', '_rev')).to.deep.equal(expectedErrorDbDoc);
    });

    it('does not process the message', () => {
      verifyStubCalls(nextDayTimestamp, 0);
    });
  });
});
