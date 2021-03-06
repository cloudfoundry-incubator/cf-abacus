'use strict';

const moment = require('abacus-moment');
const { defaults } = require('underscore');

const edebug = require('abacus-debug')('e-abacus-mocha-eventually');

const _defaultPollingIntervalInMillis = 100;
const _defaultTimeoutInMillis = 60000;

const _sleep = (duration) => {
  return new Promise((cb) => setTimeout(cb, duration));
};

const _buildDefaultConfig = () => ({
  pollingInterval: _defaultPollingIntervalInMillis,
  timeout: _defaultTimeoutInMillis
});

let _currentEventuallyConfig = _buildDefaultConfig();

const setEventuallyPollingInterval = (pollingInterval) => {
  _currentEventuallyConfig.pollingInterval = pollingInterval;
};

const setEventuallyTimeout = (timeout) => {
  _currentEventuallyConfig.timeout = timeout;
};

const resetEventuallyConfig = () => {
  _currentEventuallyConfig = _buildDefaultConfig();
};

const eventually = async (func, options) => {
  const start = moment.now();

  const eventuallyConfig = defaults(options, _currentEventuallyConfig);

  let lastError;

  do {
    try {
      return await func();
    } catch (e) {
      lastError = e;
      edebug('Eventually failed due to: %o', e);
    }
    await _sleep(eventuallyConfig.pollingInterval);

  } while(moment.now() - start < eventuallyConfig.timeout);

  throw new Error(`Eventually timeout of ${eventuallyConfig.timeout} milliseconds exceeded.` +
    `Last error occurred: ${lastError}`);
};

module.exports = {
  eventually,
  setEventuallyTimeout,
  resetEventuallyConfig,
  setEventuallyPollingInterval
};

