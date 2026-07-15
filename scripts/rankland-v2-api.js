const got = require('got');

const API_ORIGIN = 'https://rl.algoux.cn';
const API_PREFIX_URL = `${API_ORIGIN}/api/v2/`;
const CONTEST_NOT_FOUND_CODE = 100001;
const FILE_NOT_FOUND_CODE = 101000;
const COLLECTION_NOT_FOUND_CODE = 102001;

class LogicException extends Error {
  constructor(code, msg, label = 'RL API request') {
    const printableCode = code === undefined || code === null ? 'unknown' : String(code);
    const printableMsg =
      msg === undefined || msg === null || msg === '' ? 'Unknown business error' : String(msg);
    super(`${label} failed: ${printableMsg} (code: ${printableCode})`);
    this.name = 'LogicException';
    this.code = code;
    this.msg = msg;
  }
}

function createRequest(gotClient = got) {
  return gotClient.extend({
    prefixUrl: API_PREFIX_URL,
    headers: {
      'x-token': process.env.RL_API_AUTH_TOKEN,
    },
    retry: {
      limit: 0,
    },
  });
}

function extractApiEnvelope(value) {
  let body = value && value.response ? value.response.body : value && value.body;
  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return undefined;
    }
  }
  return body && typeof body === 'object' ? body : undefined;
}

function isApiBusinessResponse(body) {
  return Boolean(
    body &&
      typeof body === 'object' &&
      Object.prototype.hasOwnProperty.call(body, 'success') &&
      Object.prototype.hasOwnProperty.call(body, 'code'),
  );
}

function normalizeApiError(error, label) {
  if (error instanceof LogicException) {
    return error;
  }
  const body = extractApiEnvelope(error);
  if (isApiBusinessResponse(body) && !body.success) {
    return new LogicException(body.code, body.msg, label);
  }
  return error;
}

async function executeApiRequest(operation, label) {
  try {
    return await operation();
  } catch (error) {
    throw normalizeApiError(error, label);
  }
}

function assertApiSuccess(response, label) {
  const body = extractApiEnvelope(response);
  if (!isApiBusinessResponse(body)) {
    throw new Error(`${label} failed: unexpected response ${JSON.stringify(body)}`);
  }
  if (!body.success) {
    throw new LogicException(body.code, body.msg, label);
  }
  return body.data;
}

async function getApiResource(operation, notFoundCode, label) {
  try {
    return assertApiSuccess(await operation(), label);
  } catch (error) {
    const normalizedError = normalizeApiError(error, label);
    if (
      normalizedError instanceof LogicException &&
      Number(normalizedError.code) === notFoundCode
    ) {
      return undefined;
    }
    throw normalizedError;
  }
}

module.exports = {
  API_ORIGIN,
  API_PREFIX_URL,
  COLLECTION_NOT_FOUND_CODE,
  CONTEST_NOT_FOUND_CODE,
  FILE_NOT_FOUND_CODE,
  LogicException,
  assertApiSuccess,
  createRequest,
  executeApiRequest,
  extractApiEnvelope,
  getApiResource,
  isApiBusinessResponse,
  normalizeApiError,
};
