'use strict';

var Promise = require('bluebird');

var fs = require('fs');
var util = require('util');
var async = require('async');
var _ = require('lodash');

var readFolderRecursive = require('./utils/readFolderRecursive');
var cql = Promise.promisifyAll(require('dse-driver'));
var ORM = Promise.promisifyAll(require('./orm/apollo'));
var debug = require('debug')('express-cassandra');

var CassandraClient = function f(options) {
  var self = this;
  self.modelInstance = {};
  self.orm = new ORM(options.clientOptions, options.ormOptions);
};

CassandraClient.createClient = function (options) {
  return new CassandraClient(options);
};

CassandraClient.setDirectory = function (directory) {
  CassandraClient.directory = directory;
  return CassandraClient;
};

CassandraClient.bind = function (options, cb) {
  var self = CassandraClient;
  self.modelInstance = {};
  self.orm = new ORM(options.clientOptions, options.ormOptions);
  self.orm.connect(function (err) {
    if (err) {
      if (cb) cb(err);
      return;
    }

    readFolderRecursive(self.directory, function (err1, list) {
      if (err1) {
        if (cb) cb(err1);
        return;
      }

      async.each(list, function (fileName, callback) {
        var validFileExtensions = ['js', 'javascript', 'jsx', 'coffee', 'coffeescript', 'iced', 'script', 'ts', 'tsx', 'typescript', 'cjsx', 'co', 'json', 'json5', 'litcoffee', 'liticed', 'ls', 'node', 'toml', 'wisp'];
        var fileExtension = _.last(fileName.split('.')).toLowerCase();

        if (fileName.indexOf('Model') === -1 || validFileExtensions.indexOf(fileExtension) === -1) {
          callback();
          return;
        }

        var modelName = self._translateFileNameToModelName(file);

        if (modelName) {
          // eslint-disable-next-line import/no-dynamic-require
          var modelSchema = require(fileName);
          self.modelInstance[modelName] = self.orm.add_model(modelName.toLowerCase(), modelSchema, function (err2) {
            if (err2) callback(err2);else callback();
          });
          self.modelInstance[modelName] = Promise.promisifyAll(self.modelInstance[modelName]);
        } else {
          callback();
        }
      }, function (err3) {
        if (err3 && cb) {
          cb(err3);
        } else if (cb) {
          cb();
        }
      });
    });
  });
};

CassandraClient.bindAsync = Promise.promisify(CassandraClient.bind);

CassandraClient.prototype.connect = function f(callback) {
  var self = this;
  self.orm.connect(callback);
};

CassandraClient.prototype.connectAsync = Promise.promisify(CassandraClient.prototype.connect);

CassandraClient.prototype.loadSchema = function f(modelName, modelSchema, callback) {
  var self = this;
  var cb = function cb(err) {
    if (typeof callback === 'function') {
      if (err) callback(err);else callback(null, self.modelInstance[modelName]);
    }
  };
  self.modelInstance[modelName] = self.orm.add_model(modelName, modelSchema, cb);
  self.modelInstance[modelName] = Promise.promisifyAll(self.modelInstance[modelName]);
  return self.modelInstance[modelName];
};

CassandraClient.prototype.loadSchemaAsync = function f(modelName, modelSchema) {
  var _this = this;

  return new Promise(function (resolve, reject) {
    _this.loadSchema(modelName, modelSchema, function (err, Model) {
      if (err) reject(err);else resolve(Model);
    });
  });
};

CassandraClient.uuid = function () {
  return cql.types.Uuid.random();
};

CassandraClient.uuidFromString = function (str) {
  return cql.types.Uuid.fromString(str);
};

CassandraClient.uuidFromBuffer = function (buf) {
  return new cql.types.Uuid(buf);
};

CassandraClient.timeuuid = function () {
  return cql.types.TimeUuid.now();
};

CassandraClient.timeuuidFromDate = function (date) {
  return cql.types.TimeUuid.fromDate(date);
};

CassandraClient.timeuuidFromString = function (str) {
  return cql.types.TimeUuid.fromString(str);
};

CassandraClient.timeuuidFromBuffer = function (buf) {
  return new cql.types.TimeUuid(buf);
};

CassandraClient.maxTimeuuid = function (date) {
  return cql.types.TimeUuid.max(date);
};

CassandraClient.minTimeuuid = function (date) {
  return cql.types.TimeUuid.min(date);
};

CassandraClient.prototype.doBatch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var randomModel = this.modelInstance[Object.keys(this.modelInstance)[0]];
  var builtQueries = [];
  var beforeHooks = [];
  for (var i = 0; i < queries.length; i++) {
    builtQueries.push({
      query: queries[i].query,
      params: queries[i].params
    });
    var beforeHookAsync = Promise.promisify(queries[i].before_hook);
    beforeHooks.push(beforeHookAsync());
  }

  var batchResult = void 0;
  Promise.all(beforeHooks).then(function () {
    if (builtQueries.length > 1) {
      return randomModel.execute_batchAsync(builtQueries, options);
    }
    if (builtQueries.length > 0) {
      debug('single query provided for batch request, applying as non batch query');
      return randomModel.execute_queryAsync(builtQueries[0].query, builtQueries[0].params, options);
    }
    debug('no queries provided for batch request, empty array found, doing nothing');
    return {};
  }).then(function (response) {
    batchResult = response;
    var afterHooks = [];
    for (var _i = 0; _i < queries.length; _i++) {
      var afterHookAsync = Promise.promisify(queries[_i].after_hook);
      afterHooks.push(afterHookAsync());
    }
    return Promise.all(afterHooks);
  }).then(function () {
    callback(null, batchResult);
  }).catch(function (err) {
    callback(err);
  });
};

CassandraClient.prototype.doBatchAsync = Promise.promisify(CassandraClient.prototype.doBatch);

CassandraClient.doBatch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  CassandraClient.prototype.doBatch.call(CassandraClient, queries, options, callback);
};

CassandraClient.doBatchAsync = Promise.promisify(CassandraClient.doBatch);

CassandraClient._translateFileNameToModelName = function (fileName) {
  return fileName.slice(0, fileName.lastIndexOf('.')).replace('Model', '');
};

Object.defineProperties(CassandraClient, {
  consistencies: {
    get: function get() {
      return cql.types.consistencies;
    }
  },
  datatypes: {
    get: function get() {
      return cql.types;
    }
  },
  driver: {
    get: function get() {
      return cql;
    }
  },
  instance: {
    get: function get() {
      return CassandraClient.modelInstance;
    }
  },
  close: {
    get: function get() {
      return CassandraClient.orm.close;
    }
  },
  closeAsync: {
    get: function get() {
      return Promise.promisify(CassandraClient.orm.close);
    }
  }
});

Object.defineProperties(CassandraClient.prototype, {
  consistencies: {
    get: function get() {
      return cql.types.consistencies;
    }
  },
  datatypes: {
    get: function get() {
      return cql.types;
    }
  },
  driver: {
    get: function get() {
      return cql;
    }
  },
  instance: {
    get: function get() {
      return this.modelInstance;
    }
  },
  close: {
    get: function get() {
      return this.orm.close;
    }
  },
  closeAsync: {
    get: function get() {
      return Promise.promisify(this.orm.close);
    }
  }
});

CassandraClient.prototype.uuid = CassandraClient.uuid;
CassandraClient.prototype.uuidFromString = CassandraClient.uuidFromString;
CassandraClient.prototype.uuidFromBuffer = CassandraClient.uuidFromBuffer;
CassandraClient.prototype.timeuuid = CassandraClient.timeuuid;
CassandraClient.prototype.timeuuidFromDate = CassandraClient.timeuuidFromDate;
CassandraClient.prototype.timeuuidFromString = CassandraClient.timeuuidFromString;
CassandraClient.prototype.timeuuidFromBuffer = CassandraClient.timeuuidFromBuffer;
CassandraClient.prototype.maxTimeuuid = CassandraClient.maxTimeuuid;
CassandraClient.prototype.minTimeuuid = CassandraClient.minTimeuuid;

CassandraClient.prototype._translateFileNameToModelName = CassandraClient._translateFileNameToModelName;

module.exports = CassandraClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9leHByZXNzQ2Fzc2FuZHJhLmpzIl0sIm5hbWVzIjpbIlByb21pc2UiLCJyZXF1aXJlIiwiZnMiLCJ1dGlsIiwiYXN5bmMiLCJfIiwicmVhZEZvbGRlclJlY3Vyc2l2ZSIsImNxbCIsInByb21pc2lmeUFsbCIsIk9STSIsImRlYnVnIiwiQ2Fzc2FuZHJhQ2xpZW50IiwiZiIsIm9wdGlvbnMiLCJzZWxmIiwibW9kZWxJbnN0YW5jZSIsIm9ybSIsImNsaWVudE9wdGlvbnMiLCJvcm1PcHRpb25zIiwiY3JlYXRlQ2xpZW50Iiwic2V0RGlyZWN0b3J5IiwiZGlyZWN0b3J5IiwiYmluZCIsImNiIiwiY29ubmVjdCIsImVyciIsImVycjEiLCJsaXN0IiwiZWFjaCIsImZpbGVOYW1lIiwiY2FsbGJhY2siLCJ2YWxpZEZpbGVFeHRlbnNpb25zIiwiZmlsZUV4dGVuc2lvbiIsImxhc3QiLCJzcGxpdCIsInRvTG93ZXJDYXNlIiwiaW5kZXhPZiIsIm1vZGVsTmFtZSIsIl90cmFuc2xhdGVGaWxlTmFtZVRvTW9kZWxOYW1lIiwiZmlsZSIsIm1vZGVsU2NoZW1hIiwiYWRkX21vZGVsIiwiZXJyMiIsImVycjMiLCJiaW5kQXN5bmMiLCJwcm9taXNpZnkiLCJwcm90b3R5cGUiLCJjb25uZWN0QXN5bmMiLCJsb2FkU2NoZW1hIiwibG9hZFNjaGVtYUFzeW5jIiwicmVzb2x2ZSIsInJlamVjdCIsIk1vZGVsIiwidXVpZCIsInR5cGVzIiwiVXVpZCIsInJhbmRvbSIsInV1aWRGcm9tU3RyaW5nIiwic3RyIiwiZnJvbVN0cmluZyIsInV1aWRGcm9tQnVmZmVyIiwiYnVmIiwidGltZXV1aWQiLCJUaW1lVXVpZCIsIm5vdyIsInRpbWV1dWlkRnJvbURhdGUiLCJkYXRlIiwiZnJvbURhdGUiLCJ0aW1ldXVpZEZyb21TdHJpbmciLCJ0aW1ldXVpZEZyb21CdWZmZXIiLCJtYXhUaW1ldXVpZCIsIm1heCIsIm1pblRpbWV1dWlkIiwibWluIiwiZG9CYXRjaCIsInF1ZXJpZXMiLCJhcmd1bWVudHMiLCJsZW5ndGgiLCJkZWZhdWx0cyIsInByZXBhcmUiLCJkZWZhdWx0c0RlZXAiLCJyYW5kb21Nb2RlbCIsIk9iamVjdCIsImtleXMiLCJidWlsdFF1ZXJpZXMiLCJiZWZvcmVIb29rcyIsImkiLCJwdXNoIiwicXVlcnkiLCJwYXJhbXMiLCJiZWZvcmVIb29rQXN5bmMiLCJiZWZvcmVfaG9vayIsImJhdGNoUmVzdWx0IiwiYWxsIiwidGhlbiIsImV4ZWN1dGVfYmF0Y2hBc3luYyIsImV4ZWN1dGVfcXVlcnlBc3luYyIsInJlc3BvbnNlIiwiYWZ0ZXJIb29rcyIsImFmdGVySG9va0FzeW5jIiwiYWZ0ZXJfaG9vayIsImNhdGNoIiwiZG9CYXRjaEFzeW5jIiwiY2FsbCIsInNsaWNlIiwibGFzdEluZGV4T2YiLCJyZXBsYWNlIiwiZGVmaW5lUHJvcGVydGllcyIsImNvbnNpc3RlbmNpZXMiLCJnZXQiLCJkYXRhdHlwZXMiLCJkcml2ZXIiLCJpbnN0YW5jZSIsImNsb3NlIiwiY2xvc2VBc3luYyIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCOztBQUVBLElBQU1DLEtBQUtELFFBQVEsSUFBUixDQUFYO0FBQ0EsSUFBTUUsT0FBT0YsUUFBUSxNQUFSLENBQWI7QUFDQSxJQUFNRyxRQUFRSCxRQUFRLE9BQVIsQ0FBZDtBQUNBLElBQU1JLElBQUlKLFFBQVEsUUFBUixDQUFWOztBQUVBLElBQU1LLHNCQUFzQkwsUUFBUSw2QkFBUixDQUE1QjtBQUNBLElBQU1NLE1BQU1QLFFBQVFRLFlBQVIsQ0FBcUJQLFFBQVEsWUFBUixDQUFyQixDQUFaO0FBQ0EsSUFBTVEsTUFBTVQsUUFBUVEsWUFBUixDQUFxQlAsUUFBUSxjQUFSLENBQXJCLENBQVo7QUFDQSxJQUFNUyxRQUFRVCxRQUFRLE9BQVIsRUFBaUIsbUJBQWpCLENBQWQ7O0FBRUEsSUFBTVUsa0JBQWtCLFNBQVNDLENBQVQsQ0FBV0MsT0FBWCxFQUFvQjtBQUMxQyxN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N0YsR0FBTCxDQUFTaUcsS0FBaEI7QUFDRDtBQUhJLEdBckIwQztBQTBCakRDLGNBQVk7QUFDVkwsT0FEVSxpQkFDSjtBQUNKLGFBQU83RyxRQUFRNkMsU0FBUixDQUFrQixLQUFLN0IsR0FBTCxDQUFTaUcsS0FBM0IsQ0FBUDtBQUNEO0FBSFM7QUExQnFDLENBQW5EOztBQWtDQXRHLGdCQUFnQm1DLFNBQWhCLENBQTBCTyxJQUExQixHQUFpQzFDLGdCQUFnQjBDLElBQWpEO0FBQ0ExQyxnQkFBZ0JtQyxTQUFoQixDQUEwQlcsY0FBMUIsR0FBMkM5QyxnQkFBZ0I4QyxjQUEzRDtBQUNBOUMsZ0JBQWdCbUMsU0FBaEIsQ0FBMEJjLGNBQTFCLEdBQTJDakQsZ0JBQWdCaUQsY0FBM0Q7QUFDQWpELGdCQUFnQm1DLFNBQWhCLENBQTBCZ0IsUUFBMUIsR0FBcUNuRCxnQkFBZ0JtRCxRQUFyRDtBQUNBbkQsZ0JBQWdCbUMsU0FBaEIsQ0FBMEJtQixnQkFBMUIsR0FBNkN0RCxnQkFBZ0JzRCxnQkFBN0Q7QUFDQXRELGdCQUFnQm1DLFNBQWhCLENBQTBCc0Isa0JBQTFCLEdBQStDekQsZ0JBQWdCeUQsa0JBQS9EO0FBQ0F6RCxnQkFBZ0JtQyxTQUFoQixDQUEwQnVCLGtCQUExQixHQUErQzFELGdCQUFnQjBELGtCQUEvRDtBQUNBMUQsZ0JBQWdCbUMsU0FBaEIsQ0FBMEJ3QixXQUExQixHQUF3QzNELGdCQUFnQjJELFdBQXhEO0FBQ0EzRCxnQkFBZ0JtQyxTQUFoQixDQUEwQjBCLFdBQTFCLEdBQXdDN0QsZ0JBQWdCNkQsV0FBeEQ7O0FBRUE3RCxnQkFBZ0JtQyxTQUFoQixDQUEwQlIsNkJBQTFCLEdBQTBEM0IsZ0JBQWdCMkIsNkJBQTFFOztBQUVBNkUsT0FBT0MsT0FBUCxHQUFpQnpHLGVBQWpCIiwiZmlsZSI6ImV4cHJlc3NDYXNzYW5kcmEuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcblxuY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbmNvbnN0IGFzeW5jID0gcmVxdWlyZSgnYXN5bmMnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcblxuY29uc3QgcmVhZEZvbGRlclJlY3Vyc2l2ZSA9IHJlcXVpcmUoJy4vdXRpbHMvcmVhZEZvbGRlclJlY3Vyc2l2ZScpO1xuY29uc3QgY3FsID0gUHJvbWlzZS5wcm9taXNpZnlBbGwocmVxdWlyZSgnZHNlLWRyaXZlcicpKTtcbmNvbnN0IE9STSA9IFByb21pc2UucHJvbWlzaWZ5QWxsKHJlcXVpcmUoJy4vb3JtL2Fwb2xsbycpKTtcbmNvbnN0IGRlYnVnID0gcmVxdWlyZSgnZGVidWcnKSgnZXhwcmVzcy1jYXNzYW5kcmEnKTtcblxuY29uc3QgQ2Fzc2FuZHJhQ2xpZW50ID0gZnVuY3Rpb24gZihvcHRpb25zKSB7XG4gIGNvbnN0IHNlbGYgPSB0aGlzO1xuICBzZWxmLm1vZGVsSW5zdGFuY2UgPSB7fTtcbiAgc2VsZi5vcm0gPSBuZXcgT1JNKG9wdGlvbnMuY2xpZW50T3B0aW9ucywgb3B0aW9ucy5vcm1PcHRpb25zKTtcbn07XG5cbkNhc3NhbmRyYUNsaWVudC5jcmVhdGVDbGllbnQgPSAob3B0aW9ucykgPT4gKG5ldyBDYXNzYW5kcmFDbGllbnQob3B0aW9ucykpO1xuXG5DYXNzYW5kcmFDbGllbnQuc2V0RGlyZWN0b3J5ID0gKGRpcmVjdG9yeSkgPT4ge1xuICBDYXNzYW5kcmFDbGllbnQuZGlyZWN0b3J5ID0gZGlyZWN0b3J5O1xuICByZXR1cm4gQ2Fzc2FuZHJhQ2xpZW50O1xufTtcblxuQ2Fzc2FuZHJhQ2xpZW50LmJpbmQgPSAob3B0aW9ucywgY2IpID0+IHtcbiAgY29uc3Qgc2VsZiA9IENhc3NhbmRyYUNsaWVudDtcbiAgc2VsZi5tb2RlbEluc3RhbmNlID0ge307XG4gIHNlbGYub3JtID0gbmV3IE9STShvcHRpb25zLmNsaWVudE9wdGlvbnMsIG9wdGlvbnMub3JtT3B0aW9ucyk7XG4gIHNlbGYub3JtLmNvbm5lY3QoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGlmIChjYikgY2IoZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICByZWFkRm9sZGVyUmVjdXJzaXZlKHNlbGYuZGlyZWN0b3J5LCAoZXJyMSwgbGlzdCkgPT4ge1xuICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgaWYgKGNiKSBjYihlcnIxKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBhc3luYy5lYWNoKGxpc3QsIChmaWxlTmFtZSwgY2FsbGJhY2spID0+IHtcbiAgICAgICAgY29uc3QgdmFsaWRGaWxlRXh0ZW5zaW9ucyA9IFtcbiAgICAgICAgICAnanMnLCAnamF2YXNjcmlwdCcsICdqc3gnLCAnY29mZmVlJywgJ2NvZmZlZXNjcmlwdCcsICdpY2VkJyxcbiAgICAgICAgICAnc2NyaXB0JywgJ3RzJywgJ3RzeCcsICd0eXBlc2NyaXB0JywgJ2Nqc3gnLCAnY28nLCAnanNvbicsXG4gICAgICAgICAgJ2pzb241JywgJ2xpdGNvZmZlZScsICdsaXRpY2VkJywgJ2xzJywgJ25vZGUnLCAndG9tbCcsICd3aXNwJyxcbiAgICAgICAgXTtcbiAgICAgICAgY29uc3QgZmlsZUV4dGVuc2lvbiA9IF8ubGFzdChmaWxlTmFtZS5zcGxpdCgnLicpKS50b0xvd2VyQ2FzZSgpO1xuXG4gICAgICAgIGlmIChmaWxlTmFtZS5pbmRleE9mKCdNb2RlbCcpID09PSAtMSB8fCB2YWxpZEZpbGVFeHRlbnNpb25zLmluZGV4T2YoZmlsZUV4dGVuc2lvbikgPT09IC0xKSB7XG4gICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBtb2RlbE5hbWUgPSBzZWxmLl90cmFuc2xhdGVGaWxlTmFtZVRvTW9kZWxOYW1lKGZpbGUpO1xuXG4gICAgICAgIGlmIChtb2RlbE5hbWUpIHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWR5bmFtaWMtcmVxdWlyZVxuICAgICAgICAgIGNvbnN0IG1vZGVsU2NoZW1hID0gcmVxdWlyZShmaWxlTmFtZSk7XG4gICAgICAgICAgc2VsZi5tb2RlbEluc3RhbmNlW21vZGVsTmFtZV0gPSBzZWxmLm9ybS5hZGRfbW9kZWwoXG4gICAgICAgICAgICBtb2RlbE5hbWUudG9Mb3dlckNhc2UoKSxcbiAgICAgICAgICAgIG1vZGVsU2NoZW1hLFxuICAgICAgICAgICAgKGVycjIpID0+IHtcbiAgICAgICAgICAgICAgaWYgKGVycjIpIGNhbGxiYWNrKGVycjIpO1xuICAgICAgICAgICAgICBlbHNlIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICk7XG4gICAgICAgICAgc2VsZi5tb2RlbEluc3RhbmNlW21vZGVsTmFtZV0gPSBQcm9taXNlLnByb21pc2lmeUFsbChzZWxmLm1vZGVsSW5zdGFuY2VbbW9kZWxOYW1lXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgfVxuICAgICAgfSwgKGVycjMpID0+IHtcbiAgICAgICAgaWYgKGVycjMgJiYgY2IpIHtcbiAgICAgICAgICBjYihlcnIzKTtcbiAgICAgICAgfSBlbHNlIGlmIChjYikge1xuICAgICAgICAgIGNiKCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbkNhc3NhbmRyYUNsaWVudC5iaW5kQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeShDYXNzYW5kcmFDbGllbnQuYmluZCk7XG5cbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUuY29ubmVjdCA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gIHNlbGYub3JtLmNvbm5lY3QoY2FsbGJhY2spO1xufTtcblxuQ2Fzc2FuZHJhQ2xpZW50LnByb3RvdHlwZS5jb25uZWN0QXN5bmMgPSBQcm9taXNlLnByb21pc2lmeShDYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLmNvbm5lY3QpO1xuXG5DYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLmxvYWRTY2hlbWEgPSBmdW5jdGlvbiBmKG1vZGVsTmFtZSwgbW9kZWxTY2hlbWEsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHNlbGYgPSB0aGlzO1xuICBjb25zdCBjYiA9IGZ1bmN0aW9uIGNiKGVycikge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGlmIChlcnIpIGNhbGxiYWNrKGVycik7XG4gICAgICBlbHNlIGNhbGxiYWNrKG51bGwsIHNlbGYubW9kZWxJbnN0YW5jZVttb2RlbE5hbWVdKTtcbiAgICB9XG4gIH07XG4gIHNlbGYubW9kZWxJbnN0YW5jZVttb2RlbE5hbWVdID0gc2VsZi5vcm0uYWRkX21vZGVsKG1vZGVsTmFtZSwgbW9kZWxTY2hlbWEsIGNiKTtcbiAgc2VsZi5tb2RlbEluc3RhbmNlW21vZGVsTmFtZV0gPSBQcm9taXNlLnByb21pc2lmeUFsbChzZWxmLm1vZGVsSW5zdGFuY2VbbW9kZWxOYW1lXSk7XG4gIHJldHVybiBzZWxmLm1vZGVsSW5zdGFuY2VbbW9kZWxOYW1lXTtcbn07XG5cbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUubG9hZFNjaGVtYUFzeW5jID0gZnVuY3Rpb24gZihtb2RlbE5hbWUsIG1vZGVsU2NoZW1hKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgdGhpcy5sb2FkU2NoZW1hKG1vZGVsTmFtZSwgbW9kZWxTY2hlbWEsIChlcnIsIE1vZGVsKSA9PiB7XG4gICAgICBpZiAoZXJyKSByZWplY3QoZXJyKTtcbiAgICAgIGVsc2UgcmVzb2x2ZShNb2RlbCk7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuQ2Fzc2FuZHJhQ2xpZW50LnV1aWQgPSAoKSA9PiAoY3FsLnR5cGVzLlV1aWQucmFuZG9tKCkpO1xuXG5DYXNzYW5kcmFDbGllbnQudXVpZEZyb21TdHJpbmcgPSAoc3RyKSA9PiAoY3FsLnR5cGVzLlV1aWQuZnJvbVN0cmluZyhzdHIpKTtcblxuQ2Fzc2FuZHJhQ2xpZW50LnV1aWRGcm9tQnVmZmVyID0gKGJ1ZikgPT4gKG5ldyBjcWwudHlwZXMuVXVpZChidWYpKTtcblxuQ2Fzc2FuZHJhQ2xpZW50LnRpbWV1dWlkID0gKCkgPT4gKGNxbC50eXBlcy5UaW1lVXVpZC5ub3coKSk7XG5cbkNhc3NhbmRyYUNsaWVudC50aW1ldXVpZEZyb21EYXRlID0gKGRhdGUpID0+IChjcWwudHlwZXMuVGltZVV1aWQuZnJvbURhdGUoZGF0ZSkpO1xuXG5DYXNzYW5kcmFDbGllbnQudGltZXV1aWRGcm9tU3RyaW5nID0gKHN0cikgPT4gKGNxbC50eXBlcy5UaW1lVXVpZC5mcm9tU3RyaW5nKHN0cikpO1xuXG5DYXNzYW5kcmFDbGllbnQudGltZXV1aWRGcm9tQnVmZmVyID0gKGJ1ZikgPT4gKG5ldyBjcWwudHlwZXMuVGltZVV1aWQoYnVmKSk7XG5cbkNhc3NhbmRyYUNsaWVudC5tYXhUaW1ldXVpZCA9IChkYXRlKSA9PiAoY3FsLnR5cGVzLlRpbWVVdWlkLm1heChkYXRlKSk7XG5cbkNhc3NhbmRyYUNsaWVudC5taW5UaW1ldXVpZCA9IChkYXRlKSA9PiAoY3FsLnR5cGVzLlRpbWVVdWlkLm1pbihkYXRlKSk7XG5cbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUuZG9CYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIGNvbnN0IHJhbmRvbU1vZGVsID0gdGhpcy5tb2RlbEluc3RhbmNlW09iamVjdC5rZXlzKHRoaXMubW9kZWxJbnN0YW5jZSlbMF1dO1xuICBjb25zdCBidWlsdFF1ZXJpZXMgPSBbXTtcbiAgY29uc3QgYmVmb3JlSG9va3MgPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBxdWVyaWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgYnVpbHRRdWVyaWVzLnB1c2goe1xuICAgICAgcXVlcnk6IHF1ZXJpZXNbaV0ucXVlcnksXG4gICAgICBwYXJhbXM6IHF1ZXJpZXNbaV0ucGFyYW1zLFxuICAgIH0pO1xuICAgIGNvbnN0IGJlZm9yZUhvb2tBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHF1ZXJpZXNbaV0uYmVmb3JlX2hvb2spO1xuICAgIGJlZm9yZUhvb2tzLnB1c2goYmVmb3JlSG9va0FzeW5jKCkpO1xuICB9XG5cbiAgbGV0IGJhdGNoUmVzdWx0O1xuICBQcm9taXNlLmFsbChiZWZvcmVIb29rcylcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICBpZiAoYnVpbHRRdWVyaWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgcmV0dXJuIHJhbmRvbU1vZGVsLmV4ZWN1dGVfYmF0Y2hBc3luYyhidWlsdFF1ZXJpZXMsIG9wdGlvbnMpO1xuICAgICAgfVxuICAgICAgaWYgKGJ1aWx0UXVlcmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGRlYnVnKCdzaW5nbGUgcXVlcnkgcHJvdmlkZWQgZm9yIGJhdGNoIHJlcXVlc3QsIGFwcGx5aW5nIGFzIG5vbiBiYXRjaCBxdWVyeScpO1xuICAgICAgICByZXR1cm4gcmFuZG9tTW9kZWwuZXhlY3V0ZV9xdWVyeUFzeW5jKGJ1aWx0UXVlcmllc1swXS5xdWVyeSwgYnVpbHRRdWVyaWVzWzBdLnBhcmFtcywgb3B0aW9ucyk7XG4gICAgICB9XG4gICAgICBkZWJ1Zygnbm8gcXVlcmllcyBwcm92aWRlZCBmb3IgYmF0Y2ggcmVxdWVzdCwgZW1wdHkgYXJyYXkgZm91bmQsIGRvaW5nIG5vdGhpbmcnKTtcbiAgICAgIHJldHVybiB7fTtcbiAgICB9KVxuICAgIC50aGVuKChyZXNwb25zZSkgPT4ge1xuICAgICAgYmF0Y2hSZXN1bHQgPSByZXNwb25zZTtcbiAgICAgIGNvbnN0IGFmdGVySG9va3MgPSBbXTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcXVlcmllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBhZnRlckhvb2tBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHF1ZXJpZXNbaV0uYWZ0ZXJfaG9vayk7XG4gICAgICAgIGFmdGVySG9va3MucHVzaChhZnRlckhvb2tBc3luYygpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChhZnRlckhvb2tzKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGJhdGNoUmVzdWx0KTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgIH0pO1xufTtcblxuQ2Fzc2FuZHJhQ2xpZW50LnByb3RvdHlwZS5kb0JhdGNoQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeShDYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLmRvQmF0Y2gpO1xuXG5DYXNzYW5kcmFDbGllbnQuZG9CYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIENhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUuZG9CYXRjaC5jYWxsKENhc3NhbmRyYUNsaWVudCwgcXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spO1xufTtcblxuQ2Fzc2FuZHJhQ2xpZW50LmRvQmF0Y2hBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KENhc3NhbmRyYUNsaWVudC5kb0JhdGNoKTtcblxuQ2Fzc2FuZHJhQ2xpZW50Ll90cmFuc2xhdGVGaWxlTmFtZVRvTW9kZWxOYW1lID0gKGZpbGVOYW1lKSA9PiAoXG4gIGZpbGVOYW1lLnNsaWNlKDAsIGZpbGVOYW1lLmxhc3RJbmRleE9mKCcuJykpLnJlcGxhY2UoJ01vZGVsJywgJycpXG4pO1xuXG5PYmplY3QuZGVmaW5lUHJvcGVydGllcyhDYXNzYW5kcmFDbGllbnQsIHtcbiAgY29uc2lzdGVuY2llczoge1xuICAgIGdldCgpIHtcbiAgICAgIHJldHVybiBjcWwudHlwZXMuY29uc2lzdGVuY2llcztcbiAgICB9LFxuICB9LFxuICBkYXRhdHlwZXM6IHtcbiAgICBnZXQoKSB7XG4gICAgICByZXR1cm4gY3FsLnR5cGVzO1xuICAgIH0sXG4gIH0sXG4gIGRyaXZlcjoge1xuICAgIGdldCgpIHtcbiAgICAgIHJldHVybiBjcWw7XG4gICAgfSxcbiAgfSxcbiAgaW5zdGFuY2U6IHtcbiAgICBnZXQoKSB7XG4gICAgICByZXR1cm4gQ2Fzc2FuZHJhQ2xpZW50Lm1vZGVsSW5zdGFuY2U7XG4gICAgfSxcbiAgfSxcbiAgY2xvc2U6IHtcbiAgICBnZXQoKSB7XG4gICAgICByZXR1cm4gQ2Fzc2FuZHJhQ2xpZW50Lm9ybS5jbG9zZTtcbiAgICB9LFxuICB9LFxuICBjbG9zZUFzeW5jOiB7XG4gICAgZ2V0KCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucHJvbWlzaWZ5KENhc3NhbmRyYUNsaWVudC5vcm0uY2xvc2UpO1xuICAgIH0sXG4gIH0sXG59KTtcblxuXG5PYmplY3QuZGVmaW5lUHJvcGVydGllcyhDYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLCB7XG4gIGNvbnNpc3RlbmNpZXM6IHtcbiAgICBnZXQoKSB7XG4gICAgICByZXR1cm4gY3FsLnR5cGVzLmNvbnNpc3RlbmNpZXM7XG4gICAgfSxcbiAgfSxcbiAgZGF0YXR5cGVzOiB7XG4gICAgZ2V0KCkge1xuICAgICAgcmV0dXJuIGNxbC50eXBlcztcbiAgICB9LFxuICB9LFxuICBkcml2ZXI6IHtcbiAgICBnZXQoKSB7XG4gICAgICByZXR1cm4gY3FsO1xuICAgIH0sXG4gIH0sXG4gIGluc3RhbmNlOiB7XG4gICAgZ2V0KCkge1xuICAgICAgcmV0dXJuIHRoaXMubW9kZWxJbnN0YW5jZTtcbiAgICB9LFxuICB9LFxuICBjbG9zZToge1xuICAgIGdldCgpIHtcbiAgICAgIHJldHVybiB0aGlzLm9ybS5jbG9zZTtcbiAgICB9LFxuICB9LFxuICBjbG9zZUFzeW5jOiB7XG4gICAgZ2V0KCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucHJvbWlzaWZ5KHRoaXMub3JtLmNsb3NlKTtcbiAgICB9LFxuICB9LFxufSk7XG5cblxuQ2Fzc2FuZHJhQ2xpZW50LnByb3RvdHlwZS51dWlkID0gQ2Fzc2FuZHJhQ2xpZW50LnV1aWQ7XG5DYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLnV1aWRGcm9tU3RyaW5nID0gQ2Fzc2FuZHJhQ2xpZW50LnV1aWRGcm9tU3RyaW5nO1xuQ2Fzc2FuZHJhQ2xpZW50LnByb3RvdHlwZS51dWlkRnJvbUJ1ZmZlciA9IENhc3NhbmRyYUNsaWVudC51dWlkRnJvbUJ1ZmZlcjtcbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUudGltZXV1aWQgPSBDYXNzYW5kcmFDbGllbnQudGltZXV1aWQ7XG5DYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLnRpbWV1dWlkRnJvbURhdGUgPSBDYXNzYW5kcmFDbGllbnQudGltZXV1aWRGcm9tRGF0ZTtcbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUudGltZXV1aWRGcm9tU3RyaW5nID0gQ2Fzc2FuZHJhQ2xpZW50LnRpbWV1dWlkRnJvbVN0cmluZztcbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUudGltZXV1aWRGcm9tQnVmZmVyID0gQ2Fzc2FuZHJhQ2xpZW50LnRpbWV1dWlkRnJvbUJ1ZmZlcjtcbkNhc3NhbmRyYUNsaWVudC5wcm90b3R5cGUubWF4VGltZXV1aWQgPSBDYXNzYW5kcmFDbGllbnQubWF4VGltZXV1aWQ7XG5DYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLm1pblRpbWV1dWlkID0gQ2Fzc2FuZHJhQ2xpZW50Lm1pblRpbWV1dWlkO1xuXG5DYXNzYW5kcmFDbGllbnQucHJvdG90eXBlLl90cmFuc2xhdGVGaWxlTmFtZVRvTW9kZWxOYW1lID0gQ2Fzc2FuZHJhQ2xpZW50Ll90cmFuc2xhdGVGaWxlTmFtZVRvTW9kZWxOYW1lO1xuXG5tb2R1bGUuZXhwb3J0cyA9IENhc3NhbmRyYUNsaWVudDtcbiJdfQ==