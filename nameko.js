var events = require('events');
var amqp = require('amqp');
var uuid = require('uuid');
var winston = require('winston-color');

// TODO:
// - Add timeouts
// - Add more error handlers
// - Implement BROADCAST messages

var NamekoClient = function(options, cb) {
    var self = this;

    options = options || {};
    this._options = {
        host: options.host || '127.0.0.1',
        port: options.port || 5672,
        exchange: options.exchange || 'nameko-rpc',
        timeout: options.timeout || 5000
    };

    if (options.logger) {
        this.logger = options.logger;
    } else {
        this.logger = winston;
        winston.level = options.debug_level || 'info';
    }

    this.logger.debug('Creating Nameko client');

    this._conn = amqp.createConnection({
        host: this._options.host,
        port: this._options.port
    });

    this._conn.on('error', function(e) {
        logger.error('AMQP error:', e);
    });

    this._requests = {};

    this._conn.on('ready', function() {
        self.logger.debug('Connected to %s:%d', self._options.host, self._options.port);

        self._exchange = self._conn.exchange(
            self._options.exchange,
            {
                // TODO: can we somehow mirror exchange settings from RabbitMQ?
                type: 'topic',
                durable: true,
                autoDelete: false
            }
        );
        self._exchange.on('error', function(e) {
            self.logger.error('Exchange error: %s', e);
        });
        self._exchange.on('open', function() {
            self.logger.debug('Selected exchange %s', self._options.exchange);

            self._responseQueueName = 'rpc-node-response-' + uuid.v4();
            var ctag;

            var replyQueue = self._conn.queue(self._responseQueueName, {
                exclusive: true
            }, function(replyQueue) {
                self.logger.debug('Connected to reply queue %s', self._responseQueueName);

                replyQueue.bind(self._options.exchange, self._responseQueueName);

                replyQueue.subscribe(function(message, headers, deliveryInfo, messageObject) {
                    cid = messageObject.correlationId;
                    request = self._requests[cid];
                    if (request) {
                        self.logger.debug('[%s] Received response', cid);
                        clearTimeout(request.timeout);
                        request.callback(message.error, message.result);
                    } else {
                        self.logger.error('[%s] Received response with unknown cid!', cid);
                    }
                    delete self._requests[cid];
                }).addCallback(function(ok) {
                    ctag = ok.consumerTag;

                    self.logger.debug('Nameko client ready!');

                    self.emit('ready', self);
                    cb && cb(self);
                });
            });
        });
    });
};

NamekoClient.prototype = {
    call: function(service, method, args, kwargs, callback) {
        var self = this;
        var options = this._options;

        var body = {
            args: args || [],
            kwargs: kwargs || {}
        };

        var correlationId = uuid.v4();
        var ctag;

        self.logger.debug('[%s] Calling %s.%s(...)', correlationId, service, method);

        self._requests[correlationId] = {
            callback: callback,
            timeout: setTimeout(function() {
                delete self._requests[correlationId];
                self.logger.error('[%s] Timed out: no response within %d ms.', correlationId, self._options.timeout);
                callback(null, {
                    exc_path: null,
                    value: service + '.' + method,
                    exc_type: 'Timeout',
                    exc_args: [service, method]
                });
            }, self._options.timeout)
        };
        self._exchange.publish(
            service + '.' + method,
            JSON.stringify(body),
            {
                contentType: 'application/json',
                replyTo: self._responseQueueName,
                headers: {
                    // TODO: Research WTF is 'bar'
                    'nameko.call_id_stack': 'standalone_rpc_proxy.call.' + 'bar'
                },
                correlationId: correlationId,
                exchange: self._options.exchange
            },
            function(a, b, c) {
                logger.debug('Publish:', a, b, c);
            }
        );
    },
    close: function() {
        this._conn.disconnect();
    }
};

NamekoClient.prototype.__proto__ = events.EventEmitter.prototype;

var connect = function(options, cb) {
    if (cb) {
        return new NamekoClient(options, cb);
    } else {
        return new Promise((resolve, reject) => {
            var client = new NamekoClient(options, () => {
                resolve(client);
            });
        });
    }
};

exports.NamekoClient = NamekoClient;
exports.connect = connect;
