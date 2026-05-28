const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      const icon = { info: '→', warn: '⚠', error: '✗', debug: '·' }[level] || '·';
      return `${timestamp}  ${icon}  ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp}  ${level}  ${message}`;
        })
      )
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/uploader.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true
    })
  ]
});

module.exports = logger;
