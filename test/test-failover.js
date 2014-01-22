/*
test a failover scenario
should lose no data (atomic set/get or pub/sub) during the failover.

to use this,
  - make sure that ports 5379, 5380, and 8379 are free and open to localhost
  - ./node_modules/.bin/mocha --ui tdd --reporter spec --bail test/test-failover
*/

var should = require('should'),
    RedisSentinel = require('../index'),
    redis = require('redis'),
    pidHelpers = require('./pid-helpers'),
    async = require('async'),
    events = require('events'),
    util = require('util'),
    child_process = require('child_process'),
    fs = require('fs'),
    redisVersion = process.env.REDIS_VERSION,
    _suite


suite('sentinel failover', function(){
  
  // (want setup to run once, using BDD-style `before`)
  before( function(done){
    this.timeout(20000);
    _suite = this;
    
    function setup(){
      console.log('SETUP')

      _suite.events = new events.EventEmitter;

      _suite.hashKey = "test-sentinel-" + Math.round(Math.random() * 1000000);
      console.log("Using test hash", _suite.hashKey)

      _suite.errorLog = []
      _suite.ignoreErrors = false;

      _suite.emitError = function emitError(error){
        if (! _suite.ignoreErrors) {
          _suite.errorLog.push(error)
          _suite.events.emit('error', error);
        }
      }

      // crash whatever test is running.
      // (if it gets here, it wasn't deliberately ignored.)
      _suite.events.on('error', function(error){
        throw error;
      })
      killOldRedises();
    }

    function killOldRedises(){
      async.series([
      function(ok){
        pidHelpers.killProc(['redis-server', '5379'], ok)
      },
      function(ok){
        pidHelpers.killProc(['redis-server', '5380'], ok)
      },
      function(ok){
        pidHelpers.killProc(['redis-sentinel', '8379'], ok)
      }
    ], function(error, pids){
        if (error) return _suite.emitError(error)

        setTimeout(startCluster, 1000);
      });
    }

    function startCluster(){

      console.log('Starting Redises');

      var redisServer = './tmp/redis-' + redisVersion + '/src/redis-server';
      var redisSentinel = './tmp/redis-' + redisVersion + '/src/redis-sentinel';
      _suite.master = child_process.spawn(redisServer, ['--port', '5379', '--save', '""']);  
      _suite.slave = child_process.spawn(redisServer, ['--port', '5380', '--save', '""', '--slaveof', 'localhost', '5379']);  

      sentinelConf = fs.openSync('./tmp/sentinel.conf', 'w');
      fs.writeSync(sentinelConf,
                     'port 8379\n' +
                     'sentinel monitor mymaster 127.0.0.1 5379 1\n' + 
                     'sentinel down-after-milliseconds mymaster 5000\n' +
                     'sentinel failover-timeout mymaster 6000\n' +
                     'sentinel parallel-syncs mymaster 1\n');
      fs.closeSync(sentinelConf);
      _suite.sentinel = child_process.spawn(redisSentinel, ['./tmp/sentinel.conf']);

    setTimeout(finishBeforeHook, 10000);
    }

    function finishBeforeHook(){
    _suite.sentinelClient = RedisSentinel.createClient(8379, '127.0.0.1');

    // catch & log events
    _suite.eventLog = [];

    ['error', 'reconnecting', 'end', 'drain', 'ready', 'connect',
     'down-start', 'failover-start', 'failover-end', 'reconnected'].forEach(function(eventName){
      try {
        _suite.sentinelClient.on(eventName, function() {
          _suite.eventLog.push(eventName);
          
          var msg = 'sentinel client ' +
            (_suite.sentinelClient.server_info ? _suite.sentinelClient.server_info.role : '[no role]') + ' ' +
            (_suite.sentinelClient.server_info ? _suite.sentinelClient.server_info.tcp_port : '[no port]') + ' ' +
            'got ' + eventName;
          
          console.log(msg, util.inspect(arguments,false,0))
        })
      } catch (e) {
        console.error("can't listen to " + eventName);
      }      
    });


    _suite.waitForEvent = function(eventName, callback){
      // already happened?
      if (_suite.eventLog.indexOf(eventName) > -1) {
        callback()
      }
      else {
        // wait
        _suite.sentinelClient.on(eventName, function(){
          callback()
        })
      }
    }


    _suite.doAtomicIO = function doAtomicIO(ioCount) {
      console.log("-- set", ioCount)
      
      var n = ioCount.toString(),
        client = _suite.sentinelClient
      
      client.hset(_suite.hashKey, n, n, function(error) {
        if (error) return _suite.emitError(error)
        
        client.hget(_suite.hashKey, n, function(error, val) {
          if (error) return _suite.emitError(error)

          console.log("---- get " + n, (val === n).toString());
          
          client.hgetall(_suite.hashKey, function(error, hash) {
            if (error) return _suite.emitError(error);

            if (typeof hash !== 'object')
              return _suite.emitError(new Error("Missing hash " + _suite.hashKey));

            var missing = _suite.checkIntegrity(hash, ioCount);

            if (missing.length) {
              _suite.emitError(new Error("Missing " + missing.join(',')))
            }
            else {
              console.log('---- get/set integrity confirmed', n)
              _suite.events.emit('success', ioCount)
            }
          })
        })
      })
    }

    _suite.checkIntegrity = function checkIntegrity(values, lastValue){
      var i, missing = [];
      for (i = 1; i <= lastValue; i++) {
        if (Array.isArray(values)){   // array by value
          if (values.indexOf( i.toString() ) === -1) missing.push(i)
        }
        else if (! values[ i.toString() ]) {   // hash by key
          missing.push(i)
        }
      }
      // console.log(missing.length + ' missing for ' + lastValue, [values, missing])
      return missing
    }


    _suite.receivedPubs = []
    _suite.pubChannel = "test-sentinel-channel-" + Math.round(Math.random() * 1000000)
    console.log("Test pub/sub channel", _suite.pubChannel)

    _suite.subscriberClient = redis.createClient(5380, '127.0.0.1');

    _suite.subscriberClient.on('error', _suite.emitError);

    _suite.subscriberClient.once('ready', function(){
      _suite.subscriberClient.subscribe(_suite.pubChannel)
      _suite.subscriberClient.on('message', function(channel, message){
        if (channel === _suite.pubChannel) {
          _suite.receivedPubs.push(message)
          _suite.events.emit('message', message)
          console.log('---- received channel message', message)
        }
      })
    })

    _suite.doPub = function doPub(ioCount){
      console.log("-- pub", ioCount);
      var n = ioCount.toString();
      _suite.sentinelClient.publish(_suite.pubChannel, n, function(error, receivedBy){
        if (error) _suite.emitError(error)
      })
    }
    // wait for clients to be ready
    async.parallel([
      function(ready){
        if (_suite.sentinelClient.ready === true) ready()
        else _suite.sentinelClient.once('ready', ready)
      },
      function(ready){
        if (_suite.subscriberClient.ready === true) ready()
        else _suite.subscriberClient.once('ready', ready)
      }
    ], done)

    }

    setup();
  }); //setup

    after(function(){

      _suite.master.kill();
      _suite.slave.kill();
      _suite.sentinel.kill();

    });
  

  // sanity check
  suite('helpers', function(){
    test('checkIntegrity', function(){
      should.equal(_suite.checkIntegrity(['1','2','3'], 3).length, 0)
      should.equal(_suite.checkIntegrity({ '1': '1', '2': '2', '3': '3' }, 3).length, 0)
      should.equal(_suite.checkIntegrity({ '1': '1', '3': '3' }, 3).length, 1)
      should.equal(_suite.checkIntegrity(['1','3'], 3).length, 1)
    })
  })


  suite('failover', function(){

    before( function(){
      // repeatedly set & get some data
      _suite.ioCount = 0
      _suite.ioInterval = setInterval(function(){
        _suite.ioCount++
        _suite.doAtomicIO(_suite.ioCount)
        _suite.doPub(_suite.ioCount)
      }, 1000)
    })

    after(function(){
      if (_suite.ioInterval) clearInterval(_suite.ioInterval)
    })


    test('normal IO works', function(done){
      this.timeout(5000)

      // wait for a few good hits
      _suite.events.on('success', function(ioCount){
        if (ioCount === 3) return done()
      })
    })


    test('normal pub/sub works', function(done){
      this.timeout(5000)

      _suite.events.once('message', function(message){
        var missing = _suite.checkIntegrity( _suite.receivedPubs, _suite.ioCount );
        should.equal(missing.length, 0, "no pub/sub data missing")
        done()
      });
    })


    test('kill master', function(){
      this.timeout(30000)

      this.ignoreErrors = true;

      console.warn("*** FAILOVER CAN TAKE A WHILE, DON'T QUIT TOO SOON ***");

      console.log("Killing master")

      _suite.master.kill();
    })

    test('should get \'down-start\'', function(done){
      this.timeout(5000)
      this.waitForEvent('down-start', done)
    })


    // NOTE, failover delay is based on 'down-after-milliseconds'
    // and other params (e.g.) in sentinel.conf
    // ... 45s is very long and should suffice in a reasonable setup.


    test('should get \'failover-end\'', function(done){
      this.timeout(45000)
      this.waitForEvent('failover-end', done)
    })

    test('should get \'reconnected\'', function(done){
      this.timeout(10000)
      this.waitForEvent('reconnected', done)
    })

    test('no errors or data loss', function(){
      // shouldn't be any more errors
      this.ignoreErrors = false;

      console.log('--- should be empty', this.errorLog);

      should.equal(this.errorLog.length, 0)
    })

    test('slave is now master', function(done){
      this.timeout(5000)

      var directClient = redis.createClient(5380)
      if (!directClient) return done(new Error("Failed to create client"))

      directClient.on('error', function(error){
        console.error("Error with direct slave client")
        done(error)
      })

      directClient.once('ready', function(){
        should.equal(directClient.server_info.role, 'master')
        done()
      })
    })

    test('continous atomic I/O lost no data', function(done){
      this.timeout(2000)
      var _done = false;    // only once
      this.events.on('success', function(ioCount){
        if (ioCount >= _suite.ioCount && !_done) {
          _done = true
          done()
        }
      })
    })

    test('continous pub/sub lost no data', function(done){
      this.timeout(2000)
      var _done = false;    // only once
      this.events.on('message', function(message){
        // wait for last,
        // make sure none earlier missing
        if (+message >= _suite.ioCount && !_done) {          
          should.equal( _suite.checkIntegrity( _suite.receivedPubs, _suite.ioCount ).length, 0, "no pub/sub data missing")          
          _done = true
          done()
        }
      })
    })
  })

});
