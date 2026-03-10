/**
 * Global error handling middleware
 */

const config = require('../config');
const { ApiError } = require('../utils/errors');

function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    hint: `${req.method} ${req.path} does not exist. Check the API documentation.`
  });
}

function errorHandler(err, req, res, next) {
  if (!config.isProduction) {
    console.error('Error:', err);
  }

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON body',
      hint: 'Check your request body is valid JSON'
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = config.isProduction
    ? 'Internal server error'
    : err.message;

  res.status(statusCode).json({
    success: false,
    error: message,
    hint: 'Please try again later'
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  notFoundHandler,
  errorHandler,
  asyncHandler
};
