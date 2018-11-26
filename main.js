/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var utils     = require(__dirname + '/lib/utils'); // Get common adapter utils
var express   = require('express');
var socketio  = require('socket.io');
var LE        = require(utils.controllerDir + '/lib/letsencrypt.js');
var wetty     = require.resolve('wetty.js');
var path      = require('path');
var pty;

var webServer;
var infoTimeout;
var session;
var cookieParser;
var bodyParser;
var AdapterStore;
var passportSocketIo;
var password;
var passport;
var LocalStrategy;
var flash;
var store       = null;
var bruteForce  = {};
var secret      = 'Zgfr56gFe87jJOM'; // Will be generated by first start
var userKey     = 'connect.sid';
var server = {
    app:       null,
    server:    null,
    io:        null
};

var adapter = new utils.Adapter({
    name: 'wetty',
    install: function (callback) {
        if (typeof callback === 'function') callback();
    },
    unload: function (callback) {
        try {
            adapter.log.info('terminating http' + (webServer.settings.secure ? 's' : '') + ' server on port ' + webServer.settings.port);
            webServer.io.close();

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        main();
    }
});

function main() {
    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates(function (err, certificates, leConfig) {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;
            webServer = initWebServer(adapter.config);
        });
    } else {
        webServer = initWebServer(adapter.config);
    }
}
function updateConnectedInfo() {
    if (infoTimeout) {
        clearTimeout(infoTimeout);
        infoTimeout = null;
    }
    var text = '';
    var cnt = 0;
    if (server.io) {
        var clients = server.io.connected;

        for (var i in clients) {
            if (!clients.hasOwnProperty(i)) continue;
            text += (text ? ', ' : '') + (clients[i]._name || 'noname');
            cnt++;
        }
    }
    text = '[' + cnt + ']' + text;
    adapter.setState('info.connection', text, true);
}

function onAuthorizeSuccess(data, accept) {
    adapter.log.info('successful connection to socket.io from ' + data.connection.remoteAddress);
    //adapter.log.info(JSON.stringify(data));

    accept();
}

function onAuthorizeFail(data, message, error, accept) {
    if (error) adapter.log.error('failed connection to socket.io from ' + data.connection.remoteAddress + ':', message);

    if (error) {
        accept(new Error(message));
    } else {
        accept('failed connection to socket.io: ' + message);//null, false);
    }
    // this error will be sent to the user as a special error-package
    // see: http://socket.io/docs/client-api/#socket > error-object
}

function createSocket(server) {
    server.io = socketio(server.server, {path: '/wetty/socket.io'});

    server.io.on('connection', function (socket){
        var sshuser = '';
        var request = socket.request;

        adapter.log.info((new Date()) + ' Connection accepted.');

        updateConnectedInfo();

        var match;

        if (match = request.headers.referer.match('/wetty/ssh/.+$')) {
            sshuser = match[0].replace('/wetty/ssh/', '') + '@';
        } else if (adapter.config.globalSSHUser) {
            sshuser = adapter.config.globalSSHUser + '@';
        }

        pty = pty || require('pty.js');
        var term;
        if (process.getuid && process.getuid() === 0) {
            term = pty.spawn('/bin/login', [], {
                name: 'xterm-256color',
                cols: 80,
                rows: 30
            });
        } else {
            term = pty.spawn('ssh', [sshuser + 'localhost', '-p', adapter.config.sshPort || 22, '-o', 'PreferredAuthentications=password'], {
                name: 'xterm-256color',
                cols: 80,
                rows: 30
            });
        }

        adapter.log.info((new Date()) + ' PID=' + term.pid + ' STARTED on behalf of user=' + sshuser);

        term.on('data', function (data) {
            socket.emit('output', data);
        });
        term.on('exit', function (/* code */) {
            adapter.log.info(new Date() + ' PID=' + term.pid + ' ENDED');
        });
        socket.on('resize', function (data) {
            term.resize(data.col, data.row);
        });
        socket.on('input', function (data) {
            term.write(data);
        });
        socket.on('disconnect', function () {
            term.end();
            updateConnectedInfo();
        });
    });
    if (adapter.config.auth) {
        server.io.use(passportSocketIo.authorize({
            passport:     passport,
            cookieParser: cookieParser,
            key:          userKey,             // the name of the cookie where express/connect stores its session_id
            secret:       secret,              // the session_secret to parse the cookie
            store:        store,               // we NEED to use a sessionstore. no memorystore please
            success:      onAuthorizeSuccess,  // *optional* callback on success - read more below
            fail:         onAuthorizeFail      // *optional* callback on fail/error - read more below
        }));
    }
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//}
function initWebServer(settings) {
    server.settings = settings;
    wetty = path.dirname(wetty);

    if (settings.port) {

        server.app = express();

        server.app.use(function (req, res, next) {
            console.log(req.url);
            next();
        });
        server.app.get('/wetty/ssh/:user', function (req, res) {
            res.sendfile(path.join(wetty, '/public/wetty/index.html'));
        });

        if (settings.secure) {
            if (!settings.certificates) return null;

            if (settings.auth) {
                session =           require('express-session');
                cookieParser =      require('cookie-parser');
                bodyParser =        require('body-parser');
                AdapterStore =      require(utils.controllerDir + '/lib/session.js')(session, settings.ttl);
                passportSocketIo =  require('passport.socketio');
                password =          require(utils.controllerDir + '/lib/password.js');
                passport =          require('passport');
                LocalStrategy =     require('passport-local').Strategy;
                flash =             require('connect-flash'); // TODO report error to user

                store = new AdapterStore({adapter: adapter});

                passport.use(new LocalStrategy(
                    function (username, password, done) {
                        if (bruteForce[username] && bruteForce[username].errors > 4) {
                            var minutes = (new Date().getTime() - bruteForce[username].time);
                            if (bruteForce[username].errors < 7) {
                                if ((new Date().getTime() - bruteForce[username].time) < 60000) {
                                    minutes = 1;
                                } else {
                                    minutes = 0;
                                }
                            } else
                            if (bruteForce[username].errors < 10) {
                                if ((new Date().getTime() - bruteForce[username].time) < 180000) {
                                    minutes = Math.ceil((180000 - minutes) / 60000);
                                } else {
                                    minutes = 0;
                                }
                            } else
                            if (bruteForce[username].errors < 15) {
                                if ((new Date().getTime() - bruteForce[username].time) < 600000) {
                                    minutes = Math.ceil((600000 - minutes) / 60000);
                                } else {
                                    minutes = 0;
                                }
                            } else
                            if ((new Date().getTime() - bruteForce[username].time) < 3600000) {
                                minutes = Math.ceil((3600000 - minutes) / 60000);
                            } else {
                                minutes = 0;
                            }

                            if (minutes) {
                                return done('Too many errors. Try again in ' + minutes + ' ' + (minutes === 1 ? 'minute' : 'minutes') + '.', false);
                            }
                        }
                        adapter.checkPassword(username, password, function (res) {
                            if (!res) {
                                bruteForce[username] = bruteForce[username] || {errors: 0};
                                bruteForce[username].time = new Date().getTime();
                                bruteForce[username].errors++;
                            } else if (bruteForce[username]) {
                                delete bruteForce[username];
                            }

                            if (res) {
                                return done(null, username);
                            } else {
                                return done(null, false);
                            }
                        });

                    }
                ));
                passport.serializeUser(function (user, done) {
                    done(null, user);
                });

                passport.deserializeUser(function (user, done) {
                    done(null, user);
                });

                server.app.use(cookieParser());
                server.app.use(bodyParser.urlencoded({
                    extended: true
                }));
                server.app.use(bodyParser.json());
                server.app.use(session({
                    secret: secret,
                    saveUninitialized: true,
                    resave: true,
                    store:  store
                }));
                server.app.use(passport.initialize());
                server.app.use(passport.session());
                server.app.use(flash());

                server.app.post('/login', function (req, res, next) {
                    var redirect = '/';
                    if (req.body.origin) {
                        var parts = req.body.origin.split('=');
                        if (parts[1]) redirect = decodeURIComponent(parts[1]);
                    }
                    /* var authenticate =*/ passport.authenticate('local', {
                        successRedirect: redirect,
                        failureRedirect: '/login/index.html' + req.body.origin + (req.body.origin ? '&error' : '?error'),
                        failureFlash: 'Invalid username or password.'
                    })(req, res, next);
                });

                server.app.get('/logout', function (req, res) {
                    req.logout();
                    res.redirect('/login/index.html');
                });

                // route middleware to make sure a user is logged in
                server.app.use(function (req, res, next) {
                    if (req.isAuthenticated() ||
                        /^\/login\//.test(req.originalUrl) ||
                        /\.ico$/.test(req.originalUrl)
                    ) {
                        return next();
                    }
                    res.redirect('/login/index.html?href=' + encodeURIComponent(req.originalUrl));
                });
            }
        }

        adapter.getPort(settings.port, function (port) {
            if (port != settings.port && !settings.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            settings.port = port;

            server.server = LE.createServer(server.app, settings, settings.certificates, settings.leConfig, adapter.log);

            server.server.listen(settings.port, (settings.bind && settings.bind !== '0.0.0.0') ? settings.bind : undefined);

            settings.crossDomain     = true;
            settings.ttl             = settings.ttl || 3600;
            settings.forceWebSockets = settings.forceWebSockets || false;

            createSocket(server);

            server.app.use('/login/*', express.static(path.join(__dirname, 'public/login/')));

            var wettyPublic = express.static(path.join(wetty, 'public/'));

            server.app.use(function (req, res, next) {
                if (req.url === '/wetty/wetty.js') {
                    res.sendfile(path.join(__dirname, 'public/wetty.js'));
                } else
                if (!req.url || req.url === '/' || req.url[0] === '?' || req.url.substring(0, 2) === '/?' || req.url === '/index.html') {
                    res.sendfile(path.join(__dirname, 'public/index.html'));
                } else {
                    wettyPublic(req, res, next);
                }
            });
        });
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    return server;
}
