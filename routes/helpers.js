// Shared helpers: response format, errors, id checks, query-string parsing.

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObjectId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

function send(res, status, message, data) {
  return res.status(status).json({ message, data });
}

// Parse a JSON-encoded query param (where, sort, select, skip, limit, count)
function parseParam(req, name) {
  const raw = req.query[name];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, `Invalid JSON value for '${name}' parameter`);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function handleError(res, err) {
  if (err instanceof ApiError) return send(res, err.status, err.message, {});
  if (err && err.name === 'CastError') return send(res, 400, 'Invalid value in request', {});
  if (err && err.code === 11000) return send(res, 400, 'A user with this email already exists', {});
  // Bad projection / bad operator in where etc.
  if (err && err.name === 'MongoServerError' && [2, 9, 31253, 31254].includes(err.code)) {
    return send(res, 400, 'Invalid query parameters', {});
  }
  console.error(err);
  return send(res, 500, 'Internal server error', {});
}

// GET /users and GET /tasks
async function listHandler(Model, defaultLimit, req, res) {
  try {
    const where = parseParam(req, 'where') ?? {};
    const sort = parseParam(req, 'sort');
    const select = parseParam(req, 'select');
    const skip = parseParam(req, 'skip');
    const limit = parseParam(req, 'limit');
    const count = parseParam(req, 'count');

    if (!isPlainObject(where)) throw new ApiError(400, "'where' must be a JSON object");
    if (sort !== undefined && !isPlainObject(sort)) throw new ApiError(400, "'sort' must be a JSON object");
    if (select !== undefined && !isPlainObject(select)) throw new ApiError(400, "'select' must be a JSON object");
    for (const [k, v] of [['skip', skip], ['limit', limit]]) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        throw new ApiError(400, `'${k}' must be a non-negative integer`);
      }
    }

    let query;
    try {
      if (count === true) {
        query = Model.countDocuments(where);
        if (skip) query = query.skip(skip);
        if (limit) query = query.limit(limit);
      } else {
        query = Model.find(where);
        if (sort) query = query.sort(sort);
        if (select) query = query.select(select);
        if (skip) query = query.skip(skip);
        const lim = limit ?? defaultLimit;
        if (lim) query = query.limit(lim);
      }
    } catch {
      throw new ApiError(400, 'Invalid query parameters');
    }

    const result = await query.exec();
    return send(res, 200, 'OK', result);
  } catch (err) {
    return handleError(res, err);
  }
}

// GET /users/:id and GET /tasks/:id (only select applies)
async function getOneHandler(Model, label, req, res) {
  try {
    if (!isObjectId(req.params.id)) throw new ApiError(404, `${label} not found`);
    const select = parseParam(req, 'select');
    if (select !== undefined && !isPlainObject(select)) throw new ApiError(400, "'select' must be a JSON object");
    let query = Model.findById(req.params.id);
    if (select) query = query.select(select);
    const doc = await query.exec();
    if (!doc) throw new ApiError(404, `${label} not found`);
    return send(res, 200, 'OK', doc);
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = { ApiError, isObjectId, send, handleError, listHandler, getOneHandler };
