'use strict';

var util = require('util');
var cql = require('dse-driver');
var async = require('async');
var _ = require('lodash');
var deepDiff = require('deep-diff').diff;
var readlineSync = require('readline-sync');
var objectHash = require('object-hash');
var debug = require('debug')('express-cassandra');

var buildError = require('./apollo_error.js');
var schemer = require('./apollo_schemer');

var TYPE_MAP = require('./cassandra_types');

var checkDBTableName = function checkDBTableName(obj) {
  return typeof obj === 'string' && /^[a-zA-Z]+[a-zA-Z0-9_]*/.test(obj);
};

var BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  var fieldValues = {};
  var fields = this.constructor._properties.schema.fields;
  var methods = this.constructor._properties.schema.methods || {};
  var model = this;

  var defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  var defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (var fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    var propertyName = fieldsKeys[i];
    var field = fields[fieldsKeys[i]];

    this._validators[propertyName] = this.constructor._get_validators(propertyName);

    var setter = defaultSetter.bind(fieldValues, propertyName);
    var getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    var descriptor = {
      enumerable: true,
      set: setter,
      get: getter
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (!field.virtual) {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (var methodNames = Object.keys(methods), _i = 0, _len = methodNames.length; _i < _len; _i++) {
    var methodName = methodNames[_i];
    var method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null
};

BaseModel._set_properties = function f(properties) {
  var schema = properties.schema;
  var tableName = schema.table_name || properties.name;

  if (!checkDBTableName(tableName)) {
    throw buildError('model.tablecreation.invalidname', tableName);
  }

  var qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
};

BaseModel._validate = function f(validators, value) {
  if (value == null || _.isPlainObject(value) && value.$db_function) return true;

  for (var v = 0; v < validators.length; v++) {
    if (typeof validators[v].validator === 'function') {
      if (!validators[v].validator(value)) {
        return validators[v].message;
      }
    }
  }
  return true;
};

BaseModel._get_generic_validator_message = function f(value, propName, fieldtype) {
  return util.format('Invalid Value: "%s" for Field: %s (Type: %s)', value, propName, fieldtype);
};

BaseModel._format_validator_rule = function f(rule) {
  if (typeof rule.validator !== 'function') {
    throw buildError('model.validator.invalidrule', 'Rule validator must be a valid function');
  }
  if (!rule.message) {
    rule.message = this._get_generic_validator_message;
  } else if (typeof rule.message === 'string') {
    rule.message = function f1(message) {
      return util.format(message);
    }.bind(null, rule.message);
  } else if (typeof rule.message !== 'function') {
    throw buildError('model.validator.invalidrule', 'Invalid validator message, must be string or a function');
  }

  return rule;
};

BaseModel._get_validators = function f(fieldname) {
  var _this = this;

  var fieldtype = void 0;
  try {
    fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  } catch (e) {
    throw buildError('model.validator.invalidschema', e.message);
  }

  var validators = [];
  var typeFieldValidator = TYPE_MAP.generic_type_validator(fieldtype);

  if (typeFieldValidator) validators.push(typeFieldValidator);

  var field = this._properties.schema.fields[fieldname];
  if (typeof field.rule !== 'undefined') {
    if (typeof field.rule === 'function') {
      field.rule = {
        validator: field.rule,
        message: this._get_generic_validator_message
      };
      validators.push(field.rule);
    } else {
      if (!_.isPlainObject(field.rule)) {
        throw buildError('model.validator.invalidrule', 'Validation rule must be a function or an object');
      }
      if (field.rule.validator) {
        validators.push(this._format_validator_rule(field.rule));
      } else if (Array.isArray(field.rule.validators)) {
        field.rule.validators.forEach(function (fieldrule) {
          validators.push(_this._format_validator_rule(fieldrule));
        });
      }
    }
  }

  return validators;
};

BaseModel._ask_confirmation = function f(message) {
  var permission = 'y';
  if (!this._properties.disableTTYConfirmation) {
    permission = readlineSync.question(message);
  }
  return permission;
};

BaseModel._ensure_connected = function f(callback) {
  if (!this._properties.cql) {
    this._properties.connect(callback);
  } else {
    callback();
  }
};

BaseModel._execute_definition_query = function f(query, params, callback) {
  var _this2 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing definition query: %s with params: %j', query, params);
    var properties = _this2._properties;
    var conn = properties.define_connection;
    conn.execute(query, params, { prepare: false, fetchSize: 0 }, callback);
  });
};

BaseModel._execute_batch = function f(queries, options, callback) {
  var _this3 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing batch queries: %j', queries);
    _this3._properties.cql.batch(queries, options, callback);
  });
};

BaseModel.execute_batch = function f(queries, options, callback) {
  if (arguments.length === 2) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._execute_batch(queries, options, callback);
};

BaseModel.get_cql_client = function f(callback) {
  var _this4 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, _this4._properties.cql);
  });
};

BaseModel._create_table = function f(callback) {
  var _this5 = this;

  var properties = this._properties;
  var tableName = properties.table_name;
  var modelSchema = properties.schema;
  var dropTableOnSchemaChange = properties.dropTableOnSchemaChange;
  var migration = properties.migration;

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (dropTableOnSchemaChange) migration = 'drop';else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  this._get_db_table_schema(function (err, dbSchema) {
    if (err) {
      callback(err);
      return;
    }

    var afterCustomIndex = function afterCustomIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // materialized view creation
      if (modelSchema.materialized_views) {
        async.eachSeries(Object.keys(modelSchema.materialized_views), function (viewName, next) {
          var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
          _this5._execute_definition_query(matViewQuery, [], function (err2, result) {
            if (err2) next(buildError('model.tablecreation.matviewcreate', err2));else next(null, result);
          });
        }, callback);
      } else callback();
    };

    var afterDBIndex = function afterDBIndex(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbindexcreate', err1));
        return;
      }
      // custom index creation
      if (modelSchema.custom_indexes) {
        async.eachSeries(modelSchema.custom_indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_custom_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterCustomIndex);
      } else if (modelSchema.custom_index) {
        var customIndexQuery = _this5._create_custom_index_query(tableName, modelSchema.custom_index);
        _this5._execute_definition_query(customIndexQuery, [], function (err2, result) {
          if (err2) afterCustomIndex(err2);else afterCustomIndex(null, result);
        });
      } else afterCustomIndex();
    };

    var afterDBCreate = function afterDBCreate(err1) {
      if (err1) {
        callback(buildError('model.tablecreation.dbcreate', err1));
        return;
      }
      // index creation
      if (modelSchema.indexes instanceof Array) {
        async.eachSeries(modelSchema.indexes, function (idx, next) {
          _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err2, result) {
            if (err2) next(err2);else next(null, result);
          });
        }, afterDBIndex);
      } else afterDBIndex();
    };

    if (dbSchema) {
      var normalizedModelSchema = void 0;
      var normalizedDBSchema = void 0;

      try {
        normalizedModelSchema = schemer.normalize_model_schema(modelSchema);
        normalizedDBSchema = schemer.normalize_model_schema(dbSchema);
      } catch (e) {
        throw buildError('model.validator.invalidschema', e.message);
      }

      if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
        callback();
      } else {
        var dropRecreateTable = function dropRecreateTable() {
          var permission = _this5._ask_confirmation(util.format('Migration: model schema changed for table "%s", drop table & recreate? (data will be lost!) (y/n): ', tableName));
          if (permission.toLowerCase() === 'y') {
            if (normalizedDBSchema.materialized_views) {
              var mviews = Object.keys(normalizedDBSchema.materialized_views);

              _this5.drop_mviews(mviews, function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_table(function (err2) {
                  if (err2) {
                    callback(buildError('model.tablecreation.dbdrop', err2));
                    return;
                  }
                  var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                  _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
                });
              });
            } else {
              _this5.drop_table(function (err1) {
                if (err1) {
                  callback(buildError('model.tablecreation.dbdrop', err1));
                  return;
                }
                var createTableQuery = _this5._create_table_query(tableName, modelSchema);
                _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
              });
            }
          } else {
            callback(buildError('model.tablecreation.schemamismatch', tableName));
          }
        };

        var afterDBAlter = function afterDBAlter(err1) {
          if (err1) {
            if (err1.message !== 'break') callback(err1);
            return;
          }
          // it should create/drop indexes/custom_indexes/materialized_views that are added/removed in model schema
          // remove common indexes/custom_indexes/materialized_views from normalizedModelSchema and normalizedDBSchema
          // then drop all remaining indexes/custom_indexes/materialized_views from normalizedDBSchema
          // and add all remaining indexes/custom_indexes/materialized_views from normalizedModelSchema
          var addedIndexes = _.difference(normalizedModelSchema.indexes, normalizedDBSchema.indexes);
          var removedIndexes = _.difference(normalizedDBSchema.indexes, normalizedModelSchema.indexes);
          var removedIndexNames = [];
          removedIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[removedIndex]);
          });

          var addedCustomIndexes = _.filter(normalizedModelSchema.custom_indexes, function (obj) {
            return !_.find(normalizedDBSchema.custom_indexes, obj);
          });
          var removedCustomIndexes = _.filter(normalizedDBSchema.custom_indexes, function (obj) {
            return !_.find(normalizedModelSchema.custom_indexes, obj);
          });
          removedCustomIndexes.forEach(function (removedIndex) {
            removedIndexNames.push(dbSchema.index_names[objectHash(removedIndex)]);
          });

          var addedMaterializedViews = _.filter(Object.keys(normalizedModelSchema.materialized_views), function (viewName) {
            return !_.find(normalizedDBSchema.materialized_views, normalizedModelSchema.materialized_views[viewName]);
          });
          var removedMaterializedViews = _.filter(Object.keys(normalizedDBSchema.materialized_views), function (viewName) {
            return !_.find(normalizedModelSchema.materialized_views, normalizedDBSchema.materialized_views[viewName]);
          });

          // remove altered materialized views
          if (removedMaterializedViews.length > 0) {
            var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed materialized_views: %j, drop them? (y/n): ', tableName, removedMaterializedViews));
            if (permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }
          if (removedIndexNames.length > 0) {
            var _permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed indexes: %j, drop them? (y/n): ', tableName, removedIndexNames));
            if (_permission.toLowerCase() !== 'y') {
              callback(buildError('model.tablecreation.schemamismatch', tableName));
              return;
            }
          }

          _this5.drop_mviews(removedMaterializedViews, function (err2) {
            if (err2) {
              callback(buildError('model.tablecreation.matviewdrop', err2));
              return;
            }

            // remove altered indexes by index name
            _this5.drop_indexes(removedIndexNames, function (err3) {
              if (err3) {
                callback(buildError('model.tablecreation.dbindexdrop', err3));
                return;
              }

              // add altered indexes
              async.eachSeries(addedIndexes, function (idx, next) {
                _this5._execute_definition_query(_this5._create_index_query(tableName, idx), [], function (err4, result) {
                  if (err4) next(err4);else next(null, result);
                });
              }, function (err4) {
                if (err4) {
                  callback(buildError('model.tablecreation.dbindexcreate', err4));
                  return;
                }

                // add altered custom indexes
                async.eachSeries(addedCustomIndexes, function (idx, next) {
                  var customIndexQuery = _this5._create_custom_index_query(tableName, idx);
                  _this5._execute_definition_query(customIndexQuery, [], function (err5, result) {
                    if (err5) next(err5);else next(null, result);
                  });
                }, function (err5) {
                  if (err5) {
                    callback(buildError('model.tablecreation.dbindexcreate', err5));
                    return;
                  }

                  // add altered materialized_views
                  async.eachSeries(addedMaterializedViews, function (viewName, next) {
                    var matViewQuery = _this5._create_materialized_view_query(tableName, viewName, modelSchema.materialized_views[viewName]);
                    _this5._execute_definition_query(matViewQuery, [], function (err6, result) {
                      if (err6) next(buildError('model.tablecreation.matviewcreate', err6));else next(null, result);
                    });
                  }, callback);
                });
              });
            });
          });
        };

        var alterDBTable = function alterDBTable() {
          var differences = deepDiff(normalizedDBSchema.fields, normalizedModelSchema.fields);
          async.eachSeries(differences, function (diff, next) {
            var fieldName = diff.path[0];
            var alterFieldType = function alterFieldType() {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new type for field "%s", ' + 'alter table to update column type? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                _this5.alter_table('ALTER', fieldName, diff.rhs, function (err1, result) {
                  if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
                });
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            };

            var alterAddField = function alterAddField() {
              var type = '';
              if (diff.path.length > 1) {
                if (diff.path[1] === 'type') {
                  type = diff.rhs;
                  if (normalizedModelSchema.fields[fieldName].typeDef) {
                    type += normalizedModelSchema.fields[fieldName].typeDef;
                  }
                } else {
                  type = normalizedModelSchema.fields[fieldName].type;
                  type += diff.rhs;
                }
              } else {
                type = diff.rhs.type;
                if (diff.rhs.typeDef) type += diff.rhs.typeDef;
              }

              _this5.alter_table('ADD', fieldName, type, function (err1, result) {
                if (err1) next(buildError('model.tablecreation.dbalter', err1));else next(null, result);
              });
            };

            var alterRemoveField = function alterRemoveField(nextCallback) {
              // remove dependent indexes/custom_indexes/materialized_views,
              // update them in normalizedDBSchema, then alter
              var dependentIndexes = [];
              var pullIndexes = [];
              normalizedDBSchema.indexes.forEach(function (dbIndex) {
                var indexSplit = dbIndex.split(/[()]/g);
                var indexFieldName = '';
                if (indexSplit.length > 1) indexFieldName = indexSplit[1];else indexFieldName = indexSplit[0];
                if (indexFieldName === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[dbIndex]);
                  pullIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.indexes, pullIndexes);

              var pullCustomIndexes = [];
              normalizedDBSchema.custom_indexes.forEach(function (dbIndex) {
                if (dbIndex.on === fieldName) {
                  dependentIndexes.push(dbSchema.index_names[objectHash(dbIndex)]);
                  pullCustomIndexes.push(dbIndex);
                }
              });
              _.pullAll(normalizedDBSchema.custom_indexes, pullCustomIndexes);

              var dependentViews = [];
              Object.keys(normalizedDBSchema.materialized_views).forEach(function (dbViewName) {
                if (normalizedDBSchema.materialized_views[dbViewName].select.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].select[0] === '*') {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key.indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                } else if (normalizedDBSchema.materialized_views[dbViewName].key[0] instanceof Array && normalizedDBSchema.materialized_views[dbViewName].key[0].indexOf(fieldName) > -1) {
                  dependentViews.push(dbViewName);
                }
              });
              dependentViews.forEach(function (viewName) {
                delete normalizedDBSchema.materialized_views[viewName];
              });

              _this5.drop_mviews(dependentViews, function (err1) {
                if (err1) {
                  nextCallback(buildError('model.tablecreation.matviewdrop', err1));
                  return;
                }

                _this5.drop_indexes(dependentIndexes, function (err2) {
                  if (err2) {
                    nextCallback(buildError('model.tablecreation.dbindexdrop', err2));
                    return;
                  }

                  _this5.alter_table('DROP', fieldName, '', function (err3, result) {
                    if (err3) nextCallback(buildError('model.tablecreation.dbalter', err3));else nextCallback(null, result);
                  });
                });
              });
            };

            if (diff.kind === 'N') {
              var permission = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has added field "%s", alter table to add column? (y/n): ', tableName, fieldName));
              if (permission.toLowerCase() === 'y') {
                alterAddField();
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'D') {
              var _permission2 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has removed field "%s", alter table to drop column? ' + '(column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
              if (_permission2.toLowerCase() === 'y') {
                alterRemoveField(next);
              } else {
                next(buildError('model.tablecreation.schemamismatch', tableName));
              }
            } else if (diff.kind === 'E') {
              // check if the alter field type is possible, otherwise try D and then N
              if (diff.path[1] === 'type') {
                if (diff.lhs === 'int' && diff.rhs === 'varint') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key.indexOf(fieldName) > 0) {
                  // check if field part of clustering key
                  // alter field type impossible
                  var _permission3 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission3.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else if (['text', 'ascii', 'bigint', 'boolean', 'decimal', 'double', 'float', 'inet', 'int', 'timestamp', 'timeuuid', 'uuid', 'varchar', 'varint'].indexOf(diff.lhs) > -1 && diff.rhs === 'blob') {
                  // alter field type possible
                  alterFieldType();
                } else if (diff.lhs === 'timeuuid' && diff.rhs === 'uuid') {
                  // alter field type possible
                  alterFieldType();
                } else if (normalizedDBSchema.key[0].indexOf(fieldName) > -1) {
                  // check if field part of partition key
                  // alter field type impossible
                  var _permission4 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for primary key field "%s", ' + 'proceed to recreate table? (y/n): ', tableName, fieldName));
                  if (_permission4.toLowerCase() === 'y') {
                    dropRecreateTable();
                    next(new Error('break'));
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                } else {
                  // alter type impossible
                  var _permission5 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                  if (_permission5.toLowerCase() === 'y') {
                    alterRemoveField(function (err1) {
                      if (err1) next(err1);else alterAddField();
                    });
                  } else {
                    next(buildError('model.tablecreation.schemamismatch', tableName));
                  }
                }
              } else {
                // alter type impossible
                var _permission6 = _this5._ask_confirmation(util.format('Migration: model schema for table "%s" has new incompatible type for field "%s", drop column ' + 'and recreate? (column data will be lost & dependent indexes/views will be recreated!) (y/n): ', tableName, fieldName));
                if (_permission6.toLowerCase() === 'y') {
                  alterRemoveField(function (err1) {
                    if (err1) next(err1);else alterAddField();
                  });
                } else {
                  next(buildError('model.tablecreation.schemamismatch', tableName));
                }
              }
            } else {
              next();
            }
          }, afterDBAlter);
        };

        if (migration === 'alter') {
          // check if table can be altered to match schema
          if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) && _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
            alterDBTable();
          } else {
            dropRecreateTable();
          }
        } else if (migration === 'drop') {
          dropRecreateTable();
        } else {
          callback(buildError('model.tablecreation.schemamismatch', tableName));
        }
      }
    } else {
      // if not existing, it's created
      var createTableQuery = _this5._create_table_query(tableName, modelSchema);
      _this5._execute_definition_query(createTableQuery, [], afterDBCreate);
    }
  });
};

BaseModel._create_table_query = function f(tableName, schema) {
  var rows = [];
  var fieldType = void 0;
  Object.keys(schema.fields).forEach(function (k) {
    if (schema.fields[k].virtual) {
      return;
    }
    var segment = '';
    fieldType = schemer.get_field_type(schema, k);
    if (schema.fields[k].typeDef) {
      segment = util.format('"%s" %s%s', k, fieldType, schema.fields[k].typeDef);
    } else {
      segment = util.format('"%s" %s', k, fieldType);
    }

    if (schema.fields[k].static) {
      segment += ' STATIC';
    }

    rows.push(segment);
  });

  var partitionKey = schema.key[0];
  var clusteringKey = schema.key.slice(1, schema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (schema.clustering_order && schema.clustering_order[clusteringKey[field]] && schema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var query = util.format('CREATE TABLE IF NOT EXISTS "%s" (%s , PRIMARY KEY((%s)%s))%s;', tableName, rows.join(' , '), partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_materialized_view_query = function f(tableName, viewName, viewSchema) {
  var rows = [];

  for (var k = 0; k < viewSchema.select.length; k++) {
    if (viewSchema.select[k] === '*') rows.push(util.format('%s', viewSchema.select[k]));else rows.push(util.format('"%s"', viewSchema.select[k]));
  }

  var partitionKey = viewSchema.key[0];
  var clusteringKey = viewSchema.key.slice(1, viewSchema.key.length);
  var clusteringOrder = [];

  for (var field = 0; field < clusteringKey.length; field++) {
    if (viewSchema.clustering_order && viewSchema.clustering_order[clusteringKey[field]] && viewSchema.clustering_order[clusteringKey[field]].toLowerCase() === 'desc') {
      clusteringOrder.push(util.format('"%s" DESC', clusteringKey[field]));
    } else {
      clusteringOrder.push(util.format('"%s" ASC', clusteringKey[field]));
    }
  }

  var clusteringOrderQuery = '';
  if (clusteringOrder.length > 0) {
    clusteringOrderQuery = util.format(' WITH CLUSTERING ORDER BY (%s)', clusteringOrder.toString());
  }

  if (partitionKey instanceof Array) {
    partitionKey = partitionKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
  } else {
    partitionKey = util.format('"%s"', partitionKey);
  }

  if (clusteringKey.length) {
    clusteringKey = clusteringKey.map(function (v) {
      return util.format('"%s"', v);
    }).join(',');
    clusteringKey = util.format(',%s', clusteringKey);
  } else {
    clusteringKey = '';
  }

  var whereClause = partitionKey.split(',').join(' IS NOT NULL AND ');
  if (clusteringKey) whereClause += clusteringKey.split(',').join(' IS NOT NULL AND ');
  whereClause += ' IS NOT NULL';

  var query = util.format('CREATE MATERIALIZED VIEW IF NOT EXISTS "%s" AS SELECT %s FROM "%s" WHERE %s PRIMARY KEY((%s)%s)%s;', viewName, rows.join(' , '), tableName, whereClause, partitionKey, clusteringKey, clusteringOrderQuery);

  return query;
};

BaseModel._create_index_query = function f(tableName, indexName) {
  var query = void 0;
  var indexExpression = indexName.replace(/["\s]/g, '').split(/[()]/g);
  if (indexExpression.length > 1) {
    indexExpression[0] = indexExpression[0].toLowerCase();
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" (%s("%s"));', tableName, indexExpression[0], indexExpression[1]);
  } else {
    query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" ("%s");', tableName, indexExpression[0]);
  }

  return query;
};

BaseModel._create_custom_index_query = function f(tableName, customIndex) {
  var query = util.format('CREATE CUSTOM INDEX IF NOT EXISTS ON "%s" ("%s") USING \'%s\'', tableName, customIndex.on, customIndex.using);

  if (Object.keys(customIndex.options).length > 0) {
    query += ' WITH OPTIONS = {';
    Object.keys(customIndex.options).forEach(function (key) {
      query += util.format("'%s': '%s', ", key, customIndex.options[key]);
    });
    query = query.slice(0, -2);
    query += '}';
  }

  query += ';';

  return query;
};

BaseModel._get_db_table_schema = function f(callback) {
  var self = this;

  var tableName = this._properties.table_name;
  var keyspace = this._properties.keyspace;

  var query = 'SELECT * FROM system_schema.columns WHERE table_name = ? AND keyspace_name = ?;';

  self.execute_query(query, [tableName, keyspace], function (err, resultColumns) {
    if (err) {
      callback(buildError('model.tablecreation.dbschemaquery', err));
      return;
    }

    if (!resultColumns.rows || resultColumns.rows.length === 0) {
      callback(null, null);
      return;
    }

    var dbSchema = { fields: {}, typeMaps: {}, staticMaps: {} };

    for (var r = 0; r < resultColumns.rows.length; r++) {
      var row = resultColumns.rows[r];

      dbSchema.fields[row.column_name] = TYPE_MAP.extract_type(row.type);

      var typeMapDef = TYPE_MAP.extract_typeDef(row.type);
      if (typeMapDef.length > 0) {
        dbSchema.typeMaps[row.column_name] = typeMapDef;
      }

      if (row.kind === 'partition_key') {
        if (!dbSchema.key) dbSchema.key = [[]];
        dbSchema.key[0][row.position] = row.column_name;
      } else if (row.kind === 'clustering') {
        if (!dbSchema.key) dbSchema.key = [[]];
        if (!dbSchema.clustering_order) dbSchema.clustering_order = {};

        dbSchema.key[row.position + 1] = row.column_name;
        if (row.clustering_order && row.clustering_order.toLowerCase() === 'desc') {
          dbSchema.clustering_order[row.column_name] = 'DESC';
        } else {
          dbSchema.clustering_order[row.column_name] = 'ASC';
        }
      } else if (row.kind === 'static') {
        dbSchema.staticMaps[row.column_name] = true;
      }
    }

    query = 'SELECT * FROM system_schema.indexes WHERE table_name = ? AND keyspace_name = ?;';

    self.execute_query(query, [tableName, keyspace], function (err1, resultIndexes) {
      if (err1) {
        callback(buildError('model.tablecreation.dbschemaquery', err1));
        return;
      }

      for (var _r = 0; _r < resultIndexes.rows.length; _r++) {
        var _row = resultIndexes.rows[_r];

        if (_row.index_name) {
          var indexOptions = _row.options;
          var target = indexOptions.target;
          target = target.replace(/["\s]/g, '');
          delete indexOptions.target;

          // keeping track of index names to drop index when needed
          if (!dbSchema.index_names) dbSchema.index_names = {};

          if (_row.kind === 'CUSTOM') {
            var using = indexOptions.class_name;
            delete indexOptions.class_name;

            if (!dbSchema.custom_indexes) dbSchema.custom_indexes = [];
            var customIndexObject = {
              on: target,
              using: using,
              options: indexOptions
            };
            dbSchema.custom_indexes.push(customIndexObject);
            dbSchema.index_names[objectHash(customIndexObject)] = _row.index_name;
          } else {
            if (!dbSchema.indexes) dbSchema.indexes = [];
            dbSchema.indexes.push(target);
            dbSchema.index_names[target] = _row.index_name;
          }
        }
      }

      query = 'SELECT view_name,base_table_name FROM system_schema.views WHERE keyspace_name=?;';

      self.execute_query(query, [keyspace], function (err2, resultViews) {
        if (err2) {
          callback(buildError('model.tablecreation.dbschemaquery', err2));
          return;
        }

        for (var _r2 = 0; _r2 < resultViews.rows.length; _r2++) {
          var _row2 = resultViews.rows[_r2];

          if (_row2.base_table_name === tableName) {
            if (!dbSchema.materialized_views) dbSchema.materialized_views = {};
            dbSchema.materialized_views[_row2.view_name] = {};
          }
        }

        if (dbSchema.materialized_views) {
          query = 'SELECT * FROM system_schema.columns WHERE keyspace_name=? and table_name IN ?;';

          self.execute_query(query, [keyspace, Object.keys(dbSchema.materialized_views)], function (err3, resultMatViews) {
            if (err3) {
              callback(buildError('model.tablecreation.dbschemaquery', err3));
              return;
            }

            for (var _r3 = 0; _r3 < resultMatViews.rows.length; _r3++) {
              var _row3 = resultMatViews.rows[_r3];

              if (!dbSchema.materialized_views[_row3.table_name].select) {
                dbSchema.materialized_views[_row3.table_name].select = [];
              }

              dbSchema.materialized_views[_row3.table_name].select.push(_row3.column_name);

              if (_row3.kind === 'partition_key') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }

                dbSchema.materialized_views[_row3.table_name].key[0][_row3.position] = _row3.column_name;
              } else if (_row3.kind === 'clustering') {
                if (!dbSchema.materialized_views[_row3.table_name].key) {
                  dbSchema.materialized_views[_row3.table_name].key = [[]];
                }
                if (!dbSchema.materialized_views[_row3.table_name].clustering_order) {
                  dbSchema.materialized_views[_row3.table_name].clustering_order = {};
                }

                dbSchema.materialized_views[_row3.table_name].key[_row3.position + 1] = _row3.column_name;
                if (_row3.clustering_order && _row3.clustering_order.toLowerCase() === 'desc') {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'DESC';
                } else {
                  dbSchema.materialized_views[_row3.table_name].clustering_order[_row3.column_name] = 'ASC';
                }
              }
            }

            callback(null, dbSchema);
          });
        } else {
          callback(null, dbSchema);
        }
      });
    });
  });
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel._get_db_value_expression = function f(fieldname, fieldvalue) {
  var _this6 = this;

  if (fieldvalue == null || fieldvalue === cql.types.unset) {
    return { query_segment: '?', parameter: fieldvalue };
  }

  if (_.isPlainObject(fieldvalue) && fieldvalue.$db_function) {
    return fieldvalue.$db_function;
  }

  var fieldtype = schemer.get_field_type(this._properties.schema, fieldname);
  var validators = this._get_validators(fieldname);

  if (fieldvalue instanceof Array && fieldtype !== 'list' && fieldtype !== 'set' && fieldtype !== 'frozen') {
    var val = fieldvalue.map(function (v) {
      var dbVal = _this6._get_db_value_expression(fieldname, v);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) return dbVal.parameter;
      return dbVal;
    });

    return { query_segment: '?', parameter: val };
  }

  var validationMessage = this._validate(validators, fieldvalue);
  if (validationMessage !== true) {
    throw buildError('model.validator.invalidvalue', validationMessage(fieldvalue, fieldname, fieldtype));
  }

  if (fieldtype === 'counter') {
    var counterQuerySegment = util.format('"%s"', fieldname);
    if (fieldvalue >= 0) counterQuerySegment += ' + ?';else counterQuerySegment += ' - ?';
    fieldvalue = Math.abs(fieldvalue);
    return { query_segment: counterQuerySegment, parameter: fieldvalue };
  }

  return { query_segment: '?', parameter: fieldvalue };
};

BaseModel._create_where_clause = function f(queryObject) {
  var _this7 = this;

  var queryRelations = [];
  var queryParams = [];

  Object.keys(queryObject).forEach(function (k) {
    if (k.indexOf('$') === 0) {
      // search queries based on lucene index or solr
      // escape all single quotes for queries in cassandra
      if (k === '$expr') {
        if (typeof queryObject[k].index === 'string' && typeof queryObject[k].query === 'string') {
          queryRelations.push(util.format("expr(%s,'%s')", queryObject[k].index, queryObject[k].query.replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidexpr');
        }
      } else if (k === '$solr_query') {
        if (typeof queryObject[k] === 'string') {
          queryRelations.push(util.format("solr_query='%s'", queryObject[k].replace(/'/g, "''")));
        } else {
          throw buildError('model.find.invalidsolrquery');
        }
      }
      return;
    }

    var whereObject = queryObject[k];
    // Array of operators
    if (!(whereObject instanceof Array)) whereObject = [whereObject];

    for (var fk = 0; fk < whereObject.length; fk++) {
      var fieldRelation = whereObject[fk];

      var cqlOperators = {
        $eq: '=',
        $gt: '>',
        $lt: '<',
        $gte: '>=',
        $lte: '<=',
        $in: 'IN',
        $like: 'LIKE',
        $token: 'token',
        $contains: 'CONTAINS',
        $contains_key: 'CONTAINS KEY'
      };

      if (_.isPlainObject(fieldRelation)) {
        var validKeys = Object.keys(cqlOperators);
        var fieldRelationKeys = Object.keys(fieldRelation);
        for (var i = 0; i < fieldRelationKeys.length; i++) {
          if (validKeys.indexOf(fieldRelationKeys[i]) < 0) {
            // field relation key invalid
            fieldRelation = { $eq: fieldRelation };
            break;
          }
        }
      } else {
        fieldRelation = { $eq: fieldRelation };
      }

      var relKeys = Object.keys(fieldRelation);
      for (var rk = 0; rk < relKeys.length; rk++) {
        var firstKey = relKeys[rk];
        var firstValue = fieldRelation[firstKey];
        if (firstKey.toLowerCase() in cqlOperators) {
          firstKey = firstKey.toLowerCase();
          var op = cqlOperators[firstKey];

          if (firstKey === '$in' && !(firstValue instanceof Array)) throw buildError('model.find.invalidinop');
          if (firstKey === '$token' && !(firstValue instanceof Object)) throw buildError('model.find.invalidtoken');

          var whereTemplate = '"%s" %s %s';
          if (firstKey === '$token') {
            whereTemplate = 'token("%s") %s token(%s)';

            var tokenRelKeys = Object.keys(firstValue);
            for (var tokenRK = 0; tokenRK < tokenRelKeys.length; tokenRK++) {
              var tokenFirstKey = tokenRelKeys[tokenRK];
              var tokenFirstValue = firstValue[tokenFirstKey];
              tokenFirstKey = tokenFirstKey.toLowerCase();
              if (tokenFirstKey in cqlOperators && tokenFirstKey !== '$token' && tokenFirstKey !== '$in') {
                op = cqlOperators[tokenFirstKey];
              } else {
                throw buildError('model.find.invalidtokenop', tokenFirstKey);
              }

              if (tokenFirstValue instanceof Array) {
                var tokenKeys = k.split(',');
                for (var tokenIndex = 0; tokenIndex < tokenFirstValue.length; tokenIndex++) {
                  tokenKeys[tokenIndex] = tokenKeys[tokenIndex].trim();
                  var dbVal = _this7._get_db_value_expression(tokenKeys[tokenIndex], tokenFirstValue[tokenIndex]);
                  if (_.isPlainObject(dbVal) && dbVal.query_segment) {
                    tokenFirstValue[tokenIndex] = dbVal.query_segment;
                    queryParams.push(dbVal.parameter);
                  } else {
                    tokenFirstValue[tokenIndex] = dbVal;
                  }
                }
                queryRelations.push(util.format(whereTemplate, tokenKeys.join('","'), op, tokenFirstValue.toString()));
              } else {
                var _dbVal = _this7._get_db_value_expression(k, tokenFirstValue);
                if (_.isPlainObject(_dbVal) && _dbVal.query_segment) {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal.query_segment));
                  queryParams.push(_dbVal.parameter);
                } else {
                  queryRelations.push(util.format(whereTemplate, k, op, _dbVal));
                }
              }
            }
          } else if (firstKey === '$contains') {
            var fieldtype1 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map', 'list', 'set', 'frozen'].indexOf(fieldtype1) >= 0) {
              if (fieldtype1 === 'map' && _.isPlainObject(firstValue) && Object.keys(firstValue).length === 1) {
                queryRelations.push(util.format('"%s"[%s] %s %s', k, '?', '=', '?'));
                queryParams.push(Object.keys(firstValue)[0]);
                queryParams.push(firstValue[Object.keys(firstValue)[0]]);
              } else {
                queryRelations.push(util.format(whereTemplate, k, op, '?'));
                queryParams.push(firstValue);
              }
            } else {
              throw buildError('model.find.invalidcontainsop');
            }
          } else if (firstKey === '$contains_key') {
            var fieldtype2 = schemer.get_field_type(_this7._properties.schema, k);
            if (['map'].indexOf(fieldtype2) >= 0) {
              queryRelations.push(util.format(whereTemplate, k, op, '?'));
              queryParams.push(firstValue);
            } else {
              throw buildError('model.find.invalidcontainskeyop');
            }
          } else {
            var _dbVal2 = _this7._get_db_value_expression(k, firstValue);
            if (_.isPlainObject(_dbVal2) && _dbVal2.query_segment) {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2.query_segment));
              queryParams.push(_dbVal2.parameter);
            } else {
              queryRelations.push(util.format(whereTemplate, k, op, _dbVal2));
            }
          }
        } else {
          throw buildError('model.find.invalidop', firstKey);
        }
      }
    }
  });

  return {
    query: queryRelations.length > 0 ? util.format('WHERE %s', queryRelations.join(' AND ')) : '',
    params: queryParams
  };
};

BaseModel._create_find_query = function f(queryObject, options) {
  var orderKeys = [];
  var limit = null;

  Object.keys(queryObject).forEach(function (k) {
    var queryItem = queryObject[k];
    if (k.toLowerCase() === '$orderby') {
      if (!(queryItem instanceof Object)) {
        throw buildError('model.find.invalidorder');
      }
      var orderItemKeys = Object.keys(queryItem);
      if (orderItemKeys.length > 1) throw buildError('model.find.multiorder');

      var cqlOrderDirection = { $asc: 'ASC', $desc: 'DESC' };
      if (orderItemKeys[0].toLowerCase() in cqlOrderDirection) {
        var orderFields = queryItem[orderItemKeys[0]];

        if (!(orderFields instanceof Array)) orderFields = [orderFields];

        for (var i = 0; i < orderFields.length; i++) {
          orderKeys.push(util.format('"%s" %s', orderFields[i], cqlOrderDirection[orderItemKeys[0]]));
        }
      } else {
        throw buildError('model.find.invalidordertype', orderItemKeys[0]);
      }
    } else if (k.toLowerCase() === '$limit') {
      if (typeof queryItem !== 'number') throw buildError('model.find.limittype');
      limit = queryItem;
    }
  });

  var whereClause = this._create_where_clause(queryObject);

  var select = '*';
  if (options.select && _.isArray(options.select) && options.select.length > 0) {
    var selectArray = [];
    for (var i = 0; i < options.select.length; i++) {
      // separate the aggregate function and the column name if select is an aggregate function
      var selection = options.select[i].split(/[( )]/g).filter(function (e) {
        return e;
      });
      if (selection.length === 1) {
        selectArray.push(util.format('"%s"', selection[0]));
      } else if (selection.length === 2 || selection.length === 4) {
        var functionClause = util.format('%s("%s")', selection[0], selection[1]);
        if (selection[2]) functionClause += util.format(' %s', selection[2]);
        if (selection[3]) functionClause += util.format(' %s', selection[3]);

        selectArray.push(functionClause);
      } else if (selection.length === 3) {
        selectArray.push(util.format('"%s" %s %s', selection[0], selection[1], selection[2]));
      } else {
        selectArray.push('*');
      }
    }
    select = selectArray.join(',');
  }

  var query = util.format('SELECT %s %s FROM "%s" %s %s %s', options.distinct ? 'DISTINCT' : '', select, options.materialized_view ? options.materialized_view : this._properties.table_name, whereClause.query, orderKeys.length ? util.format('ORDER BY %s', orderKeys.join(', ')) : ' ', limit ? util.format('LIMIT %s', limit) : ' ');

  if (options.allow_filtering) query += ' ALLOW FILTERING;';else query += ';';

  return { query: query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDefinition = function f(callback) {
  var _this8 = this;

  var afterCreate = function afterCreate(err, result) {
    if (err) callback(err);else {
      _this8._ready = true;
      callback(null, result);
    }
  };

  this._create_table(afterCreate);
};

BaseModel.execute_query = function f(query, params, options, callback) {
  var _this9 = this;

  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing query: %s with params: %j', query, params);
    _this9._properties.cql.execute(query, params, options, function (err1, result) {
      if (err1 && err1.code === 8704) {
        _this9._execute_definition_query(query, params, callback);
      } else {
        callback(err1, result);
      }
    });
  });
};

BaseModel.execute_eachRow = function f(query, params, options, onReadable, callback) {
  var _this10 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing eachRow query: %s with params: %j', query, params);
    _this10._properties.cql.eachRow(query, params, options, onReadable, callback);
  });
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  var _this11 = this;

  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this11.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  var _this12 = this;

  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw buildError('model.find.eachrowerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, function (n, row) {
    if (!options.raw) {
      var ModelConstructor = _this12._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, function (err, result) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f(query, params, options, onReadable, callback) {
  var _this13 = this;

  this._ensure_connected(function (err) {
    if (err) {
      callback(err);
      return;
    }
    debug('executing stream query: %s with params: %j', query, params);
    _this13._properties.cql.stream(query, params, options).on('readable', onReadable).on('end', callback);
  });
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  var _this14 = this;

  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this14.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw buildError('model.find.streamerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  var self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    var reader = this;
    reader.readRow = function () {
      var row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        var ModelConstructor = self._properties.get_constructor();
        var o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, function (err) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  var _this15 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  var queryParams = [];

  var query = void 0;
  try {
    var findQuery = this._create_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  if (options.return_query) {
    return { query: query, params: queryParams };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      var ModelConstructor = _this15._properties.get_constructor();
      results = results.rows.map(function (res) {
        delete res.columns;
        var o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map(function (res) {
        delete res.columns;
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  var _this16 = this;

  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var updateClauseArray = [];

  var errorHappened = Object.keys(updateValues).some(function (key) {
    if (schema.fields[key] === undefined || schema.fields[key].virtual) return false;

    // check field value
    var fieldtype = schemer.get_field_type(schema, key);
    var fieldvalue = updateValues[key];

    if (fieldvalue === undefined) {
      fieldvalue = _this16._get_default_value(key);
      if (fieldvalue === undefined) {
        if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetkey', key));
            return true;
          }
          throw buildError('model.update.unsetkey', key);
        } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.unsetrequired', key));
            return true;
          }
          throw buildError('model.update.unsetrequired', key);
        } else return false;
      } else if (!schema.fields[key].rule || !schema.fields[key].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (_this16.validate(key, fieldvalue) !== true) {
          if (typeof callback === 'function') {
            callback(buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype));
            return true;
          }
          throw buildError('model.update.invaliddefaultvalue', fieldvalue, key, fieldtype);
        }
      }
    }

    if (fieldvalue === null || fieldvalue === cql.types.unset) {
      if (schema.key.indexOf(key) >= 0 || schema.key[0].indexOf(key) >= 0) {
        if (typeof callback === 'function') {
          callback(buildError('model.update.unsetkey', key));
          return true;
        }
        throw buildError('model.update.unsetkey', key);
      } else if (schema.fields[key].rule && schema.fields[key].rule.required) {
        if (typeof callback === 'function') {
          callback(buildError('model.update.unsetrequired', key));
          return true;
        }
        throw buildError('model.update.unsetrequired', key);
      }
    }

    try {
      var $add = false;
      var $append = false;
      var $prepend = false;
      var $replace = false;
      var $remove = false;
      if (_.isPlainObject(fieldvalue)) {
        if (fieldvalue.$add) {
          fieldvalue = fieldvalue.$add;
          $add = true;
        } else if (fieldvalue.$append) {
          fieldvalue = fieldvalue.$append;
          $append = true;
        } else if (fieldvalue.$prepend) {
          fieldvalue = fieldvalue.$prepend;
          $prepend = true;
        } else if (fieldvalue.$replace) {
          fieldvalue = fieldvalue.$replace;
          $replace = true;
        } else if (fieldvalue.$remove) {
          fieldvalue = fieldvalue.$remove;
          $remove = true;
        }
      }

      var dbVal = _this16._get_db_value_expression(key, fieldvalue);

      if (_.isPlainObject(dbVal) && dbVal.query_segment) {
        if (['map', 'list', 'set'].indexOf(fieldtype) > -1) {
          if ($add || $append) {
            dbVal.query_segment = util.format('"%s" + %s', key, dbVal.query_segment);
          } else if ($prepend) {
            if (fieldtype === 'list') {
              dbVal.query_segment = util.format('%s + "%s"', dbVal.query_segment, key);
            } else {
              throw buildError('model.update.invalidprependop', util.format('%s datatypes does not support $prepend, use $add instead', fieldtype));
            }
          } else if ($remove) {
            dbVal.query_segment = util.format('"%s" - %s', key, dbVal.query_segment);
            if (fieldtype === 'map') dbVal.parameter = Object.keys(dbVal.parameter);
          }
        }

        if ($replace) {
          if (fieldtype === 'map') {
            updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
            var replaceKeys = Object.keys(dbVal.parameter);
            var replaceValues = _.values(dbVal.parameter);
            if (replaceKeys.length === 1) {
              queryParams.push(replaceKeys[0]);
              queryParams.push(replaceValues[0]);
            } else {
              throw buildError('model.update.invalidreplaceop', '$replace in map does not support more than one item');
            }
          } else if (fieldtype === 'list') {
            updateClauseArray.push(util.format('"%s"[?]=%s', key, dbVal.query_segment));
            if (dbVal.parameter.length === 2) {
              queryParams.push(dbVal.parameter[0]);
              queryParams.push(dbVal.parameter[1]);
            } else {
              throw buildError('model.update.invalidreplaceop', '$replace in list should have exactly 2 items, first one as the index and the second one as the value');
            }
          } else {
            throw buildError('model.update.invalidreplaceop', util.format('%s datatypes does not support $replace', fieldtype));
          }
        } else {
          updateClauseArray.push(util.format('"%s"=%s', key, dbVal.query_segment));
          queryParams.push(dbVal.parameter);
        }
      } else {
        updateClauseArray.push(util.format('"%s"=%s', key, dbVal));
      }
    } catch (e) {
      if (typeof callback === 'function') {
        callback(e);
        return true;
      }
      throw e;
    }
    return false;
  });

  if (errorHappened) return {};

  var query = 'UPDATE "%s"';
  var where = '';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);
  query += ' SET %s %s';
  try {
    var whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }
  query = util.format(query, this._properties.table_name, updateClauseArray.join(', '), where);

  if (options.conditions) {
    var updateConditionsArray = [];

    errorHappened = Object.keys(options.conditions).some(function (key) {
      try {
        var dbVal = _this16._get_db_value_expression(key, options.conditions[key]);
        if (_.isPlainObject(dbVal) && dbVal.query_segment) {
          updateConditionsArray.push(util.format('"%s"=%s', key, dbVal.query_segment));
          queryParams.push(dbVal.parameter);
        } else {
          updateConditionsArray.push(util.format('"%s"=%s', key, dbVal));
        }
      } catch (e) {
        if (typeof callback === 'function') {
          callback(e);
          return true;
        }
        throw e;
      }
      return false;
    });

    if (errorHappened) return {};

    query += util.format(' IF %s', updateConditionsArray.join(' AND '));
  }
  if (options.if_exists) query += ' IF EXISTS';

  query += ';';

  // set dummy hook function if not present in schema
  if (typeof schema.before_update !== 'function') {
    schema.before_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_update !== 'function') {
    schema.after_update = function f1(queryObj, updateVal, optionsObj, next) {
      next();
    };
  }

  function hookRunner(fn, errorCode) {
    return function (hookCallback) {
      fn(queryObject, updateValues, options, function (error) {
        if (error) {
          hookCallback(buildError(errorCode, error));
          return;
        }
        hookCallback();
      });
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: hookRunner(schema.before_update, 'model.update.before.error'),
      after_hook: hookRunner(schema.after_update, 'model.update.after.error')
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_update(queryObject, updateValues, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.update.before.error', error));
        return;
      }
      throw buildError('model.update.before.error', error);
    }

    _this16._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.update.dberror', err));
          return;
        }
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            callback(buildError('model.update.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.update.dberror', err);
      } else {
        schema.after_update(queryObject, updateValues, options, function (error1) {
          if (error1) {
            throw buildError('model.update.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  var _this17 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var query = 'DELETE FROM "%s" %s;';
  var where = '';
  try {
    var whereClause = this._create_where_clause(queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    if (typeof callback === 'function') {
      callback(e);
      return {};
    }
    throw e;
  }

  query = util.format(query, this._properties.table_name, where);

  // set dummy hook function if not present in schema
  if (typeof schema.before_delete !== 'function') {
    schema.before_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (typeof schema.after_delete !== 'function') {
    schema.after_delete = function f1(queryObj, optionsObj, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_delete(queryObject, options, function (error) {
          if (error) {
            hookCallback(buildError('model.delete.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_delete(queryObject, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.delete.before.error', error));
        return;
      }
      throw buildError('model.delete.before.error', error);
    }

    _this17._execute_table_query(query, queryParams, queryOptions, function (err, results) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.delete.dberror', err));
          return;
        }
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            callback(buildError('model.delete.after.error', error1));
            return;
          }
          callback(null, results);
        });
      } else if (err) {
        throw buildError('model.delete.dberror', err);
      } else {
        schema.after_delete(queryObject, options, function (error1) {
          if (error1) {
            throw buildError('model.delete.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_mviews = function f(mviews, callback) {
  var _this18 = this;

  async.each(mviews, function (view, viewCallback) {
    var query = util.format('DROP MATERIALIZED VIEW IF EXISTS "%s";', view);
    _this18._execute_definition_query(query, [], viewCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.drop_indexes = function f(indexes, callback) {
  var _this19 = this;

  async.each(indexes, function (index, indexCallback) {
    var query = util.format('DROP INDEX IF EXISTS "%s";', index);
    _this19._execute_definition_query(query, [], indexCallback);
  }, function (err) {
    if (err) callback(err);else callback();
  });
};

BaseModel.alter_table = function f(operation, fieldname, type, callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  if (operation === 'ALTER') type = util.format('TYPE %s', type);else if (operation === 'DROP') type = '';

  var query = util.format('ALTER TABLE "%s" %s "%s" %s;', tableName, operation, fieldname, type);
  this._execute_definition_query(query, [], callback);
};

BaseModel.drop_table = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('DROP TABLE IF EXISTS "%s";', tableName);
  this._execute_definition_query(query, [], callback);
};

BaseModel.prototype._get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  var properties = this.constructor._properties;
  var schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return this.constructor._validate(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  var _this20 = this;

  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var identifiers = [];
  var values = [];
  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var queryParams = [];

  var errorHappened = Object.keys(schema.fields).some(function (f) {
    if (schema.fields[f].virtual) return false;

    // check field value
    var fieldtype = schemer.get_field_type(schema, f);
    var fieldvalue = _this20[f];

    if (fieldvalue === undefined) {
      fieldvalue = _this20._get_default_value(f);
      if (fieldvalue === undefined) {
        if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetkey', f));
            return true;
          }
          throw buildError('model.save.unsetkey', f);
        } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.unsetrequired', f));
            return true;
          }
          throw buildError('model.save.unsetrequired', f);
        } else return false;
      } else if (!schema.fields[f].rule || !schema.fields[f].rule.ignore_default) {
        // did set a default value, ignore default is not set
        if (_this20.validate(f, fieldvalue) !== true) {
          if (typeof callback === 'function') {
            callback(buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype));
            return true;
          }
          throw buildError('model.save.invaliddefaultvalue', fieldvalue, f, fieldtype);
        }
      }
    }

    if (fieldvalue === null || fieldvalue === cql.types.unset) {
      if (schema.key.indexOf(f) >= 0 || schema.key[0].indexOf(f) >= 0) {
        if (typeof callback === 'function') {
          callback(buildError('model.save.unsetkey', f));
          return true;
        }
        throw buildError('model.save.unsetkey', f);
      } else if (schema.fields[f].rule && schema.fields[f].rule.required) {
        if (typeof callback === 'function') {
          callback(buildError('model.save.unsetrequired', f));
          return true;
        }
        throw buildError('model.save.unsetrequired', f);
      }
    }

    identifiers.push(util.format('"%s"', f));

    try {
      var dbVal = _this20.constructor._get_db_value_expression(f, fieldvalue);
      if (_.isPlainObject(dbVal) && dbVal.query_segment) {
        values.push(dbVal.query_segment);
        queryParams.push(dbVal.parameter);
      } else {
        values.push(dbVal);
      }
    } catch (e) {
      if (typeof callback === 'function') {
        callback(e);
        return true;
      }
      throw e;
    }
    return false;
  });

  if (errorHappened) return {};

  var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

  if (options.if_not_exist) query += ' IF NOT EXISTS';
  if (options.ttl) query += util.format(' USING TTL %s', options.ttl);

  query += ';';

  // set dummy hook function if not present in schema
  if (typeof schema.before_save !== 'function') {
    schema.before_save = function f(instance, option, next) {
      next();
    };
  }

  if (typeof schema.after_save !== 'function') {
    schema.after_save = function f(instance, option, next) {
      next();
    };
  }

  if (options.return_query) {
    return {
      query: query,
      params: queryParams,
      before_hook: function before_hook(hookCallback) {
        schema.before_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.before.error', error));
            return;
          }
          hookCallback();
        });
      },
      after_hook: function after_hook(hookCallback) {
        schema.after_save(_this20, options, function (error) {
          if (error) {
            hookCallback(buildError('model.save.after.error', error));
            return;
          }
          hookCallback();
        });
      }
    };
  }

  var queryOptions = { prepare: options.prepare };
  if (options.consistency) queryOptions.consistency = options.consistency;
  if (options.fetchSize) queryOptions.fetchSize = options.fetchSize;
  if (options.autoPage) queryOptions.autoPage = options.autoPage;
  if (options.hints) queryOptions.hints = options.hints;
  if (options.pageState) queryOptions.pageState = options.pageState;
  if (options.retry) queryOptions.retry = options.retry;
  if (options.serialConsistency) queryOptions.serialConsistency = options.serialConsistency;

  schema.before_save(this, options, function (error) {
    if (error) {
      if (typeof callback === 'function') {
        callback(buildError('model.save.before.error', error));
        return;
      }
      throw buildError('model.save.before.error', error);
    }

    _this20.constructor._execute_table_query(query, queryParams, queryOptions, function (err, result) {
      if (typeof callback === 'function') {
        if (err) {
          callback(buildError('model.save.dberror', err));
          return;
        }
        if (!options.if_not_exist || result.rows && result.rows[0] && result.rows[0]['[applied]']) {
          _this20._modified = {};
        }
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            callback(buildError('model.save.after.error', error1));
            return;
          }
          callback(null, result);
        });
      } else if (err) {
        throw buildError('model.save.dberror', err);
      } else {
        schema.after_save(_this20, options, function (error1) {
          if (error1) {
            throw buildError('model.save.after.error', error1);
          }
        });
      }
    });
  });

  return {};
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this.constructor._properties.schema;
  var deleteQuery = {};

  for (var i = 0; i < schema.key.length; i++) {
    var fieldKey = schema.key[i];
    if (fieldKey instanceof Array) {
      for (var j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  var _this21 = this;

  var object = {};
  var schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach(function (field) {
    object[field] = _this21[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYmFzZV9tb2RlbC5qcyJdLCJuYW1lcyI6WyJ1dGlsIiwicmVxdWlyZSIsImNxbCIsImFzeW5jIiwiXyIsImRlZXBEaWZmIiwiZGlmZiIsInJlYWRsaW5lU3luYyIsIm9iamVjdEhhc2giLCJkZWJ1ZyIsImJ1aWxkRXJyb3IiLCJzY2hlbWVyIiwiVFlQRV9NQVAiLCJjaGVja0RCVGFibGVOYW1lIiwib2JqIiwidGVzdCIsIkJhc2VNb2RlbCIsImYiLCJpbnN0YW5jZVZhbHVlcyIsImZpZWxkVmFsdWVzIiwiZmllbGRzIiwiY29uc3RydWN0b3IiLCJfcHJvcGVydGllcyIsInNjaGVtYSIsIm1ldGhvZHMiLCJtb2RlbCIsImRlZmF1bHRTZXR0ZXIiLCJmMSIsInByb3BOYW1lIiwibmV3VmFsdWUiLCJfbW9kaWZpZWQiLCJkZWZhdWx0R2V0dGVyIiwiX3ZhbGlkYXRvcnMiLCJmaWVsZHNLZXlzIiwiT2JqZWN0Iiwia2V5cyIsImkiLCJsZW4iLCJsZW5ndGgiLCJwcm9wZXJ0eU5hbWUiLCJmaWVsZCIsIl9nZXRfdmFsaWRhdG9ycyIsInNldHRlciIsImJpbmQiLCJnZXR0ZXIiLCJ2aXJ0dWFsIiwic2V0IiwiZ2V0IiwiZGVzY3JpcHRvciIsImVudW1lcmFibGUiLCJkZWZpbmVQcm9wZXJ0eSIsIm1ldGhvZE5hbWVzIiwibWV0aG9kTmFtZSIsIm1ldGhvZCIsIm5hbWUiLCJfc2V0X3Byb3BlcnRpZXMiLCJwcm9wZXJ0aWVzIiwidGFibGVOYW1lIiwidGFibGVfbmFtZSIsInF1YWxpZmllZFRhYmxlTmFtZSIsImZvcm1hdCIsImtleXNwYWNlIiwicXVhbGlmaWVkX3RhYmxlX25hbWUiLCJfdmFsaWRhdGUiLCJ2YWxpZGF0b3JzIiwidmFsdWUiLCJpc1BsYWluT2JqZWN0IiwiJGRiX2Z1bmN0aW9uIiwidiIsInZhbGlkYXRvciIsIm1lc3NhZ2UiLCJfZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UiLCJmaWVsZHR5cGUiLCJfZm9ybWF0X3ZhbGlkYXRvcl9ydWxlIiwicnVsZSIsImZpZWxkbmFtZSIsImdldF9maWVsZF90eXBlIiwiZSIsInR5cGVGaWVsZFZhbGlkYXRvciIsImdlbmVyaWNfdHlwZV92YWxpZGF0b3IiLCJwdXNoIiwiQXJyYXkiLCJpc0FycmF5IiwiZm9yRWFjaCIsImZpZWxkcnVsZSIsIl9hc2tfY29uZmlybWF0aW9uIiwicGVybWlzc2lvbiIsImRpc2FibGVUVFlDb25maXJtYXRpb24iLCJxdWVzdGlvbiIsIl9lbnN1cmVfY29ubmVjdGVkIiwiY2FsbGJhY2siLCJjb25uZWN0IiwiX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSIsInF1ZXJ5IiwicGFyYW1zIiwiZXJyIiwiY29ubiIsImRlZmluZV9jb25uZWN0aW9uIiwiZXhlY3V0ZSIsInByZXBhcmUiLCJmZXRjaFNpemUiLCJfZXhlY3V0ZV9iYXRjaCIsInF1ZXJpZXMiLCJvcHRpb25zIiwiYmF0Y2giLCJleGVjdXRlX2JhdGNoIiwiYXJndW1lbnRzIiwiZGVmYXVsdHMiLCJkZWZhdWx0c0RlZXAiLCJnZXRfY3FsX2NsaWVudCIsIl9jcmVhdGVfdGFibGUiLCJtb2RlbFNjaGVtYSIsImRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIiwibWlncmF0aW9uIiwicHJvY2VzcyIsImVudiIsIk5PREVfRU5WIiwiX2dldF9kYl90YWJsZV9zY2hlbWEiLCJkYlNjaGVtYSIsImFmdGVyQ3VzdG9tSW5kZXgiLCJlcnIxIiwibWF0ZXJpYWxpemVkX3ZpZXdzIiwiZWFjaFNlcmllcyIsInZpZXdOYW1lIiwibmV4dCIsIm1hdFZpZXdRdWVyeSIsIl9jcmVhdGVfbWF0ZXJpYWxpemVkX3ZpZXdfcXVlcnkiLCJlcnIyIiwicmVzdWx0IiwiYWZ0ZXJEQkluZGV4IiwiY3VzdG9tX2luZGV4ZXMiLCJpZHgiLCJfY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSIsImN1c3RvbV9pbmRleCIsImN1c3RvbUluZGV4UXVlcnkiLCJhZnRlckRCQ3JlYXRlIiwiaW5kZXhlcyIsIl9jcmVhdGVfaW5kZXhfcXVlcnkiLCJub3JtYWxpemVkTW9kZWxTY2hlbWEiLCJub3JtYWxpemVkREJTY2hlbWEiLCJub3JtYWxpemVfbW9kZWxfc2NoZW1hIiwiaXNFcXVhbCIsImRyb3BSZWNyZWF0ZVRhYmxlIiwidG9Mb3dlckNhc2UiLCJtdmlld3MiLCJkcm9wX212aWV3cyIsImRyb3BfdGFibGUiLCJjcmVhdGVUYWJsZVF1ZXJ5IiwiX2NyZWF0ZV90YWJsZV9xdWVyeSIsImFmdGVyREJBbHRlciIsImFkZGVkSW5kZXhlcyIsImRpZmZlcmVuY2UiLCJyZW1vdmVkSW5kZXhlcyIsInJlbW92ZWRJbmRleE5hbWVzIiwicmVtb3ZlZEluZGV4IiwiaW5kZXhfbmFtZXMiLCJhZGRlZEN1c3RvbUluZGV4ZXMiLCJmaWx0ZXIiLCJmaW5kIiwicmVtb3ZlZEN1c3RvbUluZGV4ZXMiLCJhZGRlZE1hdGVyaWFsaXplZFZpZXdzIiwicmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzIiwiZHJvcF9pbmRleGVzIiwiZXJyMyIsImVycjQiLCJlcnI1IiwiZXJyNiIsImFsdGVyREJUYWJsZSIsImRpZmZlcmVuY2VzIiwiZmllbGROYW1lIiwicGF0aCIsImFsdGVyRmllbGRUeXBlIiwiYWx0ZXJfdGFibGUiLCJyaHMiLCJhbHRlckFkZEZpZWxkIiwidHlwZSIsInR5cGVEZWYiLCJhbHRlclJlbW92ZUZpZWxkIiwibmV4dENhbGxiYWNrIiwiZGVwZW5kZW50SW5kZXhlcyIsInB1bGxJbmRleGVzIiwiZGJJbmRleCIsImluZGV4U3BsaXQiLCJzcGxpdCIsImluZGV4RmllbGROYW1lIiwicHVsbEFsbCIsInB1bGxDdXN0b21JbmRleGVzIiwib24iLCJkZXBlbmRlbnRWaWV3cyIsImRiVmlld05hbWUiLCJzZWxlY3QiLCJpbmRleE9mIiwia2V5Iiwia2luZCIsImxocyIsIkVycm9yIiwiY2x1c3RlcmluZ19vcmRlciIsInJvd3MiLCJmaWVsZFR5cGUiLCJrIiwic2VnbWVudCIsInN0YXRpYyIsInBhcnRpdGlvbktleSIsImNsdXN0ZXJpbmdLZXkiLCJzbGljZSIsImNsdXN0ZXJpbmdPcmRlciIsImNsdXN0ZXJpbmdPcmRlclF1ZXJ5IiwidG9TdHJpbmciLCJtYXAiLCJqb2luIiwidmlld1NjaGVtYSIsIndoZXJlQ2xhdXNlIiwiaW5kZXhOYW1lIiwiaW5kZXhFeHByZXNzaW9uIiwicmVwbGFjZSIsImN1c3RvbUluZGV4IiwidXNpbmciLCJzZWxmIiwiZXhlY3V0ZV9xdWVyeSIsInJlc3VsdENvbHVtbnMiLCJ0eXBlTWFwcyIsInN0YXRpY01hcHMiLCJyIiwicm93IiwiY29sdW1uX25hbWUiLCJleHRyYWN0X3R5cGUiLCJ0eXBlTWFwRGVmIiwiZXh0cmFjdF90eXBlRGVmIiwicG9zaXRpb24iLCJyZXN1bHRJbmRleGVzIiwiaW5kZXhfbmFtZSIsImluZGV4T3B0aW9ucyIsInRhcmdldCIsImNsYXNzX25hbWUiLCJjdXN0b21JbmRleE9iamVjdCIsInJlc3VsdFZpZXdzIiwiYmFzZV90YWJsZV9uYW1lIiwidmlld19uYW1lIiwicmVzdWx0TWF0Vmlld3MiLCJfZXhlY3V0ZV90YWJsZV9xdWVyeSIsImRvRXhlY3V0ZVF1ZXJ5IiwiZG9xdWVyeSIsImRvY2FsbGJhY2siLCJpc190YWJsZV9yZWFkeSIsImluaXQiLCJfZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24iLCJmaWVsZHZhbHVlIiwidHlwZXMiLCJ1bnNldCIsInF1ZXJ5X3NlZ21lbnQiLCJwYXJhbWV0ZXIiLCJ2YWwiLCJkYlZhbCIsInZhbGlkYXRpb25NZXNzYWdlIiwiY291bnRlclF1ZXJ5U2VnbWVudCIsIk1hdGgiLCJhYnMiLCJfY3JlYXRlX3doZXJlX2NsYXVzZSIsInF1ZXJ5T2JqZWN0IiwicXVlcnlSZWxhdGlvbnMiLCJxdWVyeVBhcmFtcyIsImluZGV4Iiwid2hlcmVPYmplY3QiLCJmayIsImZpZWxkUmVsYXRpb24iLCJjcWxPcGVyYXRvcnMiLCIkZXEiLCIkZ3QiLCIkbHQiLCIkZ3RlIiwiJGx0ZSIsIiRpbiIsIiRsaWtlIiwiJHRva2VuIiwiJGNvbnRhaW5zIiwiJGNvbnRhaW5zX2tleSIsInZhbGlkS2V5cyIsImZpZWxkUmVsYXRpb25LZXlzIiwicmVsS2V5cyIsInJrIiwiZmlyc3RLZXkiLCJmaXJzdFZhbHVlIiwib3AiLCJ3aGVyZVRlbXBsYXRlIiwidG9rZW5SZWxLZXlzIiwidG9rZW5SSyIsInRva2VuRmlyc3RLZXkiLCJ0b2tlbkZpcnN0VmFsdWUiLCJ0b2tlbktleXMiLCJ0b2tlbkluZGV4IiwidHJpbSIsImZpZWxkdHlwZTEiLCJmaWVsZHR5cGUyIiwiX2NyZWF0ZV9maW5kX3F1ZXJ5Iiwib3JkZXJLZXlzIiwibGltaXQiLCJxdWVyeUl0ZW0iLCJvcmRlckl0ZW1LZXlzIiwiY3FsT3JkZXJEaXJlY3Rpb24iLCIkYXNjIiwiJGRlc2MiLCJvcmRlckZpZWxkcyIsInNlbGVjdEFycmF5Iiwic2VsZWN0aW9uIiwiZnVuY3Rpb25DbGF1c2UiLCJkaXN0aW5jdCIsIm1hdGVyaWFsaXplZF92aWV3IiwiYWxsb3dfZmlsdGVyaW5nIiwiZ2V0X3RhYmxlX25hbWUiLCJfcmVhZHkiLCJ1bmRlZmluZWQiLCJzeW5jRGVmaW5pdGlvbiIsImFmdGVyQ3JlYXRlIiwiY29kZSIsImV4ZWN1dGVfZWFjaFJvdyIsIm9uUmVhZGFibGUiLCJlYWNoUm93IiwiX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyIsImNiIiwicmF3IiwicmV0dXJuX3F1ZXJ5Iiwic2VsZWN0UXVlcnkiLCJxdWVyeU9wdGlvbnMiLCJjb25zaXN0ZW5jeSIsImF1dG9QYWdlIiwiaGludHMiLCJwYWdlU3RhdGUiLCJyZXRyeSIsInNlcmlhbENvbnNpc3RlbmN5IiwibiIsIk1vZGVsQ29uc3RydWN0b3IiLCJnZXRfY29uc3RydWN0b3IiLCJleGVjdXRlX3N0cmVhbSIsInN0cmVhbSIsIl9leGVjdXRlX3RhYmxlX3N0cmVhbSIsInJlYWRlciIsInJlYWRSb3ciLCJyZWFkIiwibyIsImZpbmRRdWVyeSIsImNvbmNhdCIsInJlc3VsdHMiLCJyZXMiLCJjb2x1bW5zIiwiZmluZE9uZSIsIiRsaW1pdCIsInVwZGF0ZSIsInVwZGF0ZVZhbHVlcyIsInVwZGF0ZUNsYXVzZUFycmF5IiwiZXJyb3JIYXBwZW5lZCIsInNvbWUiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJyZXF1aXJlZCIsImlnbm9yZV9kZWZhdWx0IiwidmFsaWRhdGUiLCIkYWRkIiwiJGFwcGVuZCIsIiRwcmVwZW5kIiwiJHJlcGxhY2UiLCIkcmVtb3ZlIiwicmVwbGFjZUtleXMiLCJyZXBsYWNlVmFsdWVzIiwidmFsdWVzIiwid2hlcmUiLCJ0dGwiLCJjb25kaXRpb25zIiwidXBkYXRlQ29uZGl0aW9uc0FycmF5IiwiaWZfZXhpc3RzIiwiYmVmb3JlX3VwZGF0ZSIsInF1ZXJ5T2JqIiwidXBkYXRlVmFsIiwib3B0aW9uc09iaiIsImFmdGVyX3VwZGF0ZSIsImhvb2tSdW5uZXIiLCJmbiIsImVycm9yQ29kZSIsImhvb2tDYWxsYmFjayIsImVycm9yIiwiYmVmb3JlX2hvb2siLCJhZnRlcl9ob29rIiwiZXJyb3IxIiwiZGVsZXRlIiwiYmVmb3JlX2RlbGV0ZSIsImFmdGVyX2RlbGV0ZSIsInRydW5jYXRlIiwiZWFjaCIsInZpZXciLCJ2aWV3Q2FsbGJhY2siLCJpbmRleENhbGxiYWNrIiwib3BlcmF0aW9uIiwicHJvdG90eXBlIiwiX2dldF9kYXRhX3R5cGVzIiwiZGVmYXVsdCIsImNhbGwiLCJzYXZlIiwiaWRlbnRpZmllcnMiLCJpZl9ub3RfZXhpc3QiLCJiZWZvcmVfc2F2ZSIsImluc3RhbmNlIiwib3B0aW9uIiwiYWZ0ZXJfc2F2ZSIsImRlbGV0ZVF1ZXJ5IiwiZmllbGRLZXkiLCJqIiwidG9KU09OIiwib2JqZWN0IiwiaXNNb2RpZmllZCIsImhhc093blByb3BlcnR5IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7QUFBQSxJQUFNQSxPQUFPQyxRQUFRLE1BQVIsQ0FBYjtBQUNBLElBQU1DLE1BQU1ELFFBQVEsWUFBUixDQUFaO0FBQ0EsSUFBTUUsUUFBUUYsUUFBUSxPQUFSLENBQWQ7QUFDQSxJQUFNRyxJQUFJSCxRQUFRLFFBQVIsQ0FBVjtBQUNBLElBQU1JLFdB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S0FBRCxFQUFXO0FBQzVDNlcsV0FBTzdXLEtBQVAsSUFBZ0IsUUFBS0EsS0FBTCxDQUFoQjtBQUNELEdBRkQ7O0FBSUEsU0FBTzZXLE1BQVA7QUFDRCxDQVREOztBQVdBclksVUFBVXNYLFNBQVYsQ0FBb0JnQixVQUFwQixHQUFpQyxTQUFTQSxVQUFULENBQW9CMVgsUUFBcEIsRUFBOEI7QUFDN0QsTUFBSUEsUUFBSixFQUFjO0FBQ1osV0FBT00sT0FBT29XLFNBQVAsQ0FBaUJpQixjQUFqQixDQUFnQ2QsSUFBaEMsQ0FBcUMsS0FBSzNXLFNBQTFDLEVBQXFERixRQUFyRCxDQUFQO0FBQ0Q7QUFDRCxTQUFPTSxPQUFPQyxJQUFQLENBQVksS0FBS0wsU0FBakIsRUFBNEJRLE1BQTVCLEtBQXVDLENBQTlDO0FBQ0QsQ0FMRDs7QUFPQWtYLE9BQU9DLE9BQVAsR0FBaUJ6WSxTQUFqQiIsImZpbGUiOiJiYXNlX21vZGVsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcbmNvbnN0IGNxbCA9IHJlcXVpcmUoJ2RzZS1kcml2ZXInKTtcbmNvbnN0IGFzeW5jID0gcmVxdWlyZSgnYXN5bmMnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IGRlZXBEaWZmID0gcmVxdWlyZSgnZGVlcC1kaWZmJykuZGlmZjtcbmNvbnN0IHJlYWRsaW5lU3luYyA9IHJlcXVpcmUoJ3JlYWRsaW5lLXN5bmMnKTtcbmNvbnN0IG9iamVjdEhhc2ggPSByZXF1aXJlKCdvYmplY3QtaGFzaCcpO1xuY29uc3QgZGVidWcgPSByZXF1aXJlKCdkZWJ1ZycpKCdleHByZXNzLWNhc3NhbmRyYScpO1xuXG5jb25zdCBidWlsZEVycm9yID0gcmVxdWlyZSgnLi9hcG9sbG9fZXJyb3IuanMnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuL2Fwb2xsb19zY2hlbWVyJyk7XG5cbmNvbnN0IFRZUEVfTUFQID0gcmVxdWlyZSgnLi9jYXNzYW5kcmFfdHlwZXMnKTtcblxuY29uc3QgY2hlY2tEQlRhYmxlTmFtZSA9IChvYmopID0+ICgodHlwZW9mIG9iaiA9PT0gJ3N0cmluZycgJiYgL15bYS16QS1aXStbYS16QS1aMC05X10qLy50ZXN0KG9iaikpKTtcblxuY29uc3QgQmFzZU1vZGVsID0gZnVuY3Rpb24gZihpbnN0YW5jZVZhbHVlcykge1xuICBpbnN0YW5jZVZhbHVlcyA9IGluc3RhbmNlVmFsdWVzIHx8IHt9O1xuICBjb25zdCBmaWVsZFZhbHVlcyA9IHt9O1xuICBjb25zdCBmaWVsZHMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYS5maWVsZHM7XG4gIGNvbnN0IG1ldGhvZHMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYS5tZXRob2RzIHx8IHt9O1xuICBjb25zdCBtb2RlbCA9IHRoaXM7XG5cbiAgY29uc3QgZGVmYXVsdFNldHRlciA9IGZ1bmN0aW9uIGYxKHByb3BOYW1lLCBuZXdWYWx1ZSkge1xuICAgIGlmICh0aGlzW3Byb3BOYW1lXSAhPT0gbmV3VmFsdWUpIHtcbiAgICAgIG1vZGVsLl9tb2RpZmllZFtwcm9wTmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICB0aGlzW3Byb3BOYW1lXSA9IG5ld1ZhbHVlO1xuICB9O1xuXG4gIGNvbnN0IGRlZmF1bHRHZXR0ZXIgPSBmdW5jdGlvbiBmMShwcm9wTmFtZSkge1xuICAgIHJldHVybiB0aGlzW3Byb3BOYW1lXTtcbiAgfTtcblxuICB0aGlzLl9tb2RpZmllZCA9IHt9O1xuICB0aGlzLl92YWxpZGF0b3JzID0ge307XG5cbiAgZm9yIChsZXQgZmllbGRzS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkcyksIGkgPSAwLCBsZW4gPSBmaWVsZHNLZXlzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgcHJvcGVydHlOYW1lID0gZmllbGRzS2V5c1tpXTtcbiAgICBjb25zdCBmaWVsZCA9IGZpZWxkc1tmaWVsZHNLZXlzW2ldXTtcblxuICAgIHRoaXMuX3ZhbGlkYXRvcnNbcHJvcGVydHlOYW1lXSA9IHRoaXMuY29uc3RydWN0b3IuX2dldF92YWxpZGF0b3JzKHByb3BlcnR5TmFtZSk7XG5cbiAgICBsZXQgc2V0dGVyID0gZGVmYXVsdFNldHRlci5iaW5kKGZpZWxkVmFsdWVzLCBwcm9wZXJ0eU5hbWUpO1xuICAgIGxldCBnZXR0ZXIgPSBkZWZhdWx0R2V0dGVyLmJpbmQoZmllbGRWYWx1ZXMsIHByb3BlcnR5TmFtZSk7XG5cbiAgICBpZiAoZmllbGQudmlydHVhbCAmJiB0eXBlb2YgZmllbGQudmlydHVhbC5zZXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHNldHRlciA9IGZpZWxkLnZpcnR1YWwuc2V0LmJpbmQoZmllbGRWYWx1ZXMpO1xuICAgIH1cblxuICAgIGlmIChmaWVsZC52aXJ0dWFsICYmIHR5cGVvZiBmaWVsZC52aXJ0dWFsLmdldCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgZ2V0dGVyID0gZmllbGQudmlydHVhbC5nZXQuYmluZChmaWVsZFZhbHVlcyk7XG4gICAgfVxuXG4gICAgY29uc3QgZGVzY3JpcHRvciA9IHtcbiAgICAgIGVudW1lcmFibGU6IHRydWUsXG4gICAgICBzZXQ6IHNldHRlcixcbiAgICAgIGdldDogZ2V0dGVyLFxuICAgIH07XG5cbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgcHJvcGVydHlOYW1lLCBkZXNjcmlwdG9yKTtcbiAgICBpZiAoIWZpZWxkLnZpcnR1YWwpIHtcbiAgICAgIHRoaXNbcHJvcGVydHlOYW1lXSA9IGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV07XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgbWV0aG9kTmFtZXMgPSBPYmplY3Qua2V5cyhtZXRob2RzKSwgaSA9IDAsIGxlbiA9IG1ldGhvZE5hbWVzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgbWV0aG9kTmFtZSA9IG1ldGhvZE5hbWVzW2ldO1xuICAgIGNvbnN0IG1ldGhvZCA9IG1ldGhvZHNbbWV0aG9kTmFtZV07XG4gICAgdGhpc1ttZXRob2ROYW1lXSA9IG1ldGhvZDtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9wcm9wZXJ0aWVzID0ge1xuICBuYW1lOiBudWxsLFxuICBzY2hlbWE6IG51bGwsXG59O1xuXG5CYXNlTW9kZWwuX3NldF9wcm9wZXJ0aWVzID0gZnVuY3Rpb24gZihwcm9wZXJ0aWVzKSB7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuICBjb25zdCB0YWJsZU5hbWUgPSBzY2hlbWEudGFibGVfbmFtZSB8fCBwcm9wZXJ0aWVzLm5hbWU7XG5cbiAgaWYgKCFjaGVja0RCVGFibGVOYW1lKHRhYmxlTmFtZSkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5pbnZhbGlkbmFtZScsIHRhYmxlTmFtZSkpO1xuICB9XG5cbiAgY29uc3QgcXVhbGlmaWVkVGFibGVOYW1lID0gdXRpbC5mb3JtYXQoJ1wiJXNcIi5cIiVzXCInLCBwcm9wZXJ0aWVzLmtleXNwYWNlLCB0YWJsZU5hbWUpO1xuXG4gIHRoaXMuX3Byb3BlcnRpZXMgPSBwcm9wZXJ0aWVzO1xuICB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUgPSB0YWJsZU5hbWU7XG4gIHRoaXMuX3Byb3BlcnRpZXMucXVhbGlmaWVkX3RhYmxlX25hbWUgPSBxdWFsaWZpZWRUYWJsZU5hbWU7XG59O1xuXG5CYXNlTW9kZWwuX3ZhbGlkYXRlID0gZnVuY3Rpb24gZih2YWxpZGF0b3JzLCB2YWx1ZSkge1xuICBpZiAodmFsdWUgPT0gbnVsbCB8fCAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS4kZGJfZnVuY3Rpb24pKSByZXR1cm4gdHJ1ZTtcblxuICBmb3IgKGxldCB2ID0gMDsgdiA8IHZhbGlkYXRvcnMubGVuZ3RoOyB2KyspIHtcbiAgICBpZiAodHlwZW9mIHZhbGlkYXRvcnNbdl0udmFsaWRhdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBpZiAoIXZhbGlkYXRvcnNbdl0udmFsaWRhdG9yKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gdmFsaWRhdG9yc1t2XS5tZXNzYWdlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkJhc2VNb2RlbC5fZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UgPSBmdW5jdGlvbiBmKHZhbHVlLCBwcm9wTmFtZSwgZmllbGR0eXBlKSB7XG4gIHJldHVybiB1dGlsLmZvcm1hdCgnSW52YWxpZCBWYWx1ZTogXCIlc1wiIGZvciBGaWVsZDogJXMgKFR5cGU6ICVzKScsIHZhbHVlLCBwcm9wTmFtZSwgZmllbGR0eXBlKTtcbn07XG5cbkJhc2VNb2RlbC5fZm9ybWF0X3ZhbGlkYXRvcl9ydWxlID0gZnVuY3Rpb24gZihydWxlKSB7XG4gIGlmICh0eXBlb2YgcnVsZS52YWxpZGF0b3IgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ1J1bGUgdmFsaWRhdG9yIG11c3QgYmUgYSB2YWxpZCBmdW5jdGlvbicpKTtcbiAgfVxuICBpZiAoIXJ1bGUubWVzc2FnZSkge1xuICAgIHJ1bGUubWVzc2FnZSA9IHRoaXMuX2dldF9nZW5lcmljX3ZhbGlkYXRvcl9tZXNzYWdlO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBydWxlLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XG4gICAgcnVsZS5tZXNzYWdlID0gZnVuY3Rpb24gZjEobWVzc2FnZSkge1xuICAgICAgcmV0dXJuIHV0aWwuZm9ybWF0KG1lc3NhZ2UpO1xuICAgIH0uYmluZChudWxsLCBydWxlLm1lc3NhZ2UpO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBydWxlLm1lc3NhZ2UgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ0ludmFsaWQgdmFsaWRhdG9yIG1lc3NhZ2UsIG11c3QgYmUgc3RyaW5nIG9yIGEgZnVuY3Rpb24nKSk7XG4gIH1cblxuICByZXR1cm4gcnVsZTtcbn07XG5cbkJhc2VNb2RlbC5fZ2V0X3ZhbGlkYXRvcnMgPSBmdW5jdGlvbiBmKGZpZWxkbmFtZSkge1xuICBsZXQgZmllbGR0eXBlO1xuICB0cnkge1xuICAgIGZpZWxkdHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUodGhpcy5fcHJvcGVydGllcy5zY2hlbWEsIGZpZWxkbmFtZSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCBlLm1lc3NhZ2UpKTtcbiAgfVxuXG4gIGNvbnN0IHZhbGlkYXRvcnMgPSBbXTtcbiAgY29uc3QgdHlwZUZpZWxkVmFsaWRhdG9yID0gVFlQRV9NQVAuZ2VuZXJpY190eXBlX3ZhbGlkYXRvcihmaWVsZHR5cGUpO1xuXG4gIGlmICh0eXBlRmllbGRWYWxpZGF0b3IpIHZhbGlkYXRvcnMucHVzaCh0eXBlRmllbGRWYWxpZGF0b3IpO1xuXG4gIGNvbnN0IGZpZWxkID0gdGhpcy5fcHJvcGVydGllcy5zY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV07XG4gIGlmICh0eXBlb2YgZmllbGQucnVsZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBpZiAodHlwZW9mIGZpZWxkLnJ1bGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGZpZWxkLnJ1bGUgPSB7XG4gICAgICAgIHZhbGlkYXRvcjogZmllbGQucnVsZSxcbiAgICAgICAgbWVzc2FnZTogdGhpcy5fZ2V0X2dlbmVyaWNfdmFsaWRhdG9yX21lc3NhZ2UsXG4gICAgICB9O1xuICAgICAgdmFsaWRhdG9ycy5wdXNoKGZpZWxkLnJ1bGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChmaWVsZC5ydWxlKSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRydWxlJywgJ1ZhbGlkYXRpb24gcnVsZSBtdXN0IGJlIGEgZnVuY3Rpb24gb3IgYW4gb2JqZWN0JykpO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLnJ1bGUudmFsaWRhdG9yKSB7XG4gICAgICAgIHZhbGlkYXRvcnMucHVzaCh0aGlzLl9mb3JtYXRfdmFsaWRhdG9yX3J1bGUoZmllbGQucnVsZSkpO1xuICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KGZpZWxkLnJ1bGUudmFsaWRhdG9ycykpIHtcbiAgICAgICAgZmllbGQucnVsZS52YWxpZGF0b3JzLmZvckVhY2goKGZpZWxkcnVsZSkgPT4ge1xuICAgICAgICAgIHZhbGlkYXRvcnMucHVzaCh0aGlzLl9mb3JtYXRfdmFsaWRhdG9yX3J1bGUoZmllbGRydWxlKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB2YWxpZGF0b3JzO1xufTtcblxuQmFzZU1vZGVsLl9hc2tfY29uZmlybWF0aW9uID0gZnVuY3Rpb24gZihtZXNzYWdlKSB7XG4gIGxldCBwZXJtaXNzaW9uID0gJ3knO1xuICBpZiAoIXRoaXMuX3Byb3BlcnRpZXMuZGlzYWJsZVRUWUNvbmZpcm1hdGlvbikge1xuICAgIHBlcm1pc3Npb24gPSByZWFkbGluZVN5bmMucXVlc3Rpb24obWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIHBlcm1pc3Npb247XG59O1xuXG5CYXNlTW9kZWwuX2Vuc3VyZV9jb25uZWN0ZWQgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGlmICghdGhpcy5fcHJvcGVydGllcy5jcWwpIHtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNvbm5lY3QoY2FsbGJhY2spO1xuICB9IGVsc2Uge1xuICAgIGNhbGxiYWNrKCk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBjYWxsYmFjaykge1xuICB0aGlzLl9lbnN1cmVfY29ubmVjdGVkKChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkZWJ1ZygnZXhlY3V0aW5nIGRlZmluaXRpb24gcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IGNvbm4gPSBwcm9wZXJ0aWVzLmRlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbm4uZXhlY3V0ZShxdWVyeSwgcGFyYW1zLCB7IHByZXBhcmU6IGZhbHNlLCBmZXRjaFNpemU6IDAgfSwgY2FsbGJhY2spO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9iYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdGhpcy5fZW5zdXJlX2Nvbm5lY3RlZCgoZXJyKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVidWcoJ2V4ZWN1dGluZyBiYXRjaCBxdWVyaWVzOiAlaicsIHF1ZXJpZXMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmJhdGNoKHF1ZXJpZXMsIG9wdGlvbnMsIGNhbGxiYWNrKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9iYXRjaCA9IGZ1bmN0aW9uIGYocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIHRoaXMuX2V4ZWN1dGVfYmF0Y2gocXVlcmllcywgb3B0aW9ucywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmdldF9jcWxfY2xpZW50ID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICB0aGlzLl9lbnN1cmVfY29ubmVjdGVkKChlcnIpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhudWxsLCB0aGlzLl9wcm9wZXJ0aWVzLmNxbCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfdGFibGUgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gIGNvbnN0IG1vZGVsU2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlID0gcHJvcGVydGllcy5kcm9wVGFibGVPblNjaGVtYUNoYW5nZTtcbiAgbGV0IG1pZ3JhdGlvbiA9IHByb3BlcnRpZXMubWlncmF0aW9uO1xuXG4gIC8vIGJhY2t3YXJkcyBjb21wYXRpYmxlIGNoYW5nZSwgZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2Ugd2lsbCB3b3JrIGxpa2UgbWlncmF0aW9uOiAnZHJvcCdcbiAgaWYgKCFtaWdyYXRpb24pIHtcbiAgICBpZiAoZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2UpIG1pZ3JhdGlvbiA9ICdkcm9wJztcbiAgICBlbHNlIG1pZ3JhdGlvbiA9ICdzYWZlJztcbiAgfVxuICAvLyBhbHdheXMgc2FmZSBtaWdyYXRlIGlmIE5PREVfRU5WPT09J3Byb2R1Y3Rpb24nXG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gJ3Byb2R1Y3Rpb24nKSBtaWdyYXRpb24gPSAnc2FmZSc7XG5cbiAgLy8gY2hlY2sgZm9yIGV4aXN0ZW5jZSBvZiB0YWJsZSBvbiBEQiBhbmQgaWYgaXQgbWF0Y2hlcyB0aGlzIG1vZGVsJ3Mgc2NoZW1hXG4gIHRoaXMuX2dldF9kYl90YWJsZV9zY2hlbWEoKGVyciwgZGJTY2hlbWEpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGFmdGVyQ3VzdG9tSW5kZXggPSAoZXJyMSkgPT4ge1xuICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyMSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBtYXRlcmlhbGl6ZWQgdmlldyBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICBhc3luYy5lYWNoU2VyaWVzKE9iamVjdC5rZXlzKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyksICh2aWV3TmFtZSwgbmV4dCkgPT4ge1xuICAgICAgICAgIGNvbnN0IG1hdFZpZXdRdWVyeSA9IHRoaXMuX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeShcbiAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgIHZpZXdOYW1lLFxuICAgICAgICAgICAgbW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShtYXRWaWV3UXVlcnksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyMikgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLm1hdHZpZXdjcmVhdGUnLCBlcnIyKSk7XG4gICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgY2FsbGJhY2spO1xuICAgICAgfSBlbHNlIGNhbGxiYWNrKCk7XG4gICAgfTtcblxuICAgIGNvbnN0IGFmdGVyREJJbmRleCA9IChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhjcmVhdGUnLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIGN1c3RvbSBpbmRleCBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzKSB7XG4gICAgICAgIGFzeW5jLmVhY2hTZXJpZXMobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkodGhpcy5fY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSh0YWJsZU5hbWUsIGlkeCksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZXJyMikgbmV4dChlcnIyKTtcbiAgICAgICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9LCBhZnRlckN1c3RvbUluZGV4KTtcbiAgICAgIH0gZWxzZSBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KSB7XG4gICAgICAgIGNvbnN0IGN1c3RvbUluZGV4UXVlcnkgPSB0aGlzLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KTtcbiAgICAgICAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KGN1c3RvbUluZGV4UXVlcnksIFtdLCAoZXJyMiwgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKGVycjIpIGFmdGVyQ3VzdG9tSW5kZXgoZXJyMik7XG4gICAgICAgICAgZWxzZSBhZnRlckN1c3RvbUluZGV4KG51bGwsIHJlc3VsdCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGFmdGVyQ3VzdG9tSW5kZXgoKTtcbiAgICB9O1xuXG4gICAgY29uc3QgYWZ0ZXJEQkNyZWF0ZSA9IChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiY3JlYXRlJywgZXJyMSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBpbmRleCBjcmVhdGlvblxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmluZGV4ZXMgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgICBhc3luYy5lYWNoU2VyaWVzKG1vZGVsU2NoZW1hLmluZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkodGhpcy5fY3JlYXRlX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KSwgW10sIChlcnIyLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIyKSBuZXh0KGVycjIpO1xuICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sIGFmdGVyREJJbmRleCk7XG4gICAgICB9IGVsc2UgYWZ0ZXJEQkluZGV4KCk7XG4gICAgfTtcblxuICAgIGlmIChkYlNjaGVtYSkge1xuICAgICAgbGV0IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYTtcbiAgICAgIGxldCBub3JtYWxpemVkREJTY2hlbWE7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSA9IHNjaGVtZXIubm9ybWFsaXplX21vZGVsX3NjaGVtYShtb2RlbFNjaGVtYSk7XG4gICAgICAgIG5vcm1hbGl6ZWREQlNjaGVtYSA9IHNjaGVtZXIubm9ybWFsaXplX21vZGVsX3NjaGVtYShkYlNjaGVtYSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuXG4gICAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hKSkge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZHJvcFJlY3JlYXRlVGFibGUgPSAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGNoYW5nZWQgZm9yIHRhYmxlIFwiJXNcIiwgZHJvcCB0YWJsZSAmIHJlY3JlYXRlPyAoZGF0YSB3aWxsIGJlIGxvc3QhKSAoeS9uKTogJyxcbiAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIHtcbiAgICAgICAgICAgICAgY29uc3QgbXZpZXdzID0gT2JqZWN0LmtleXMobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyk7XG5cbiAgICAgICAgICAgICAgdGhpcy5kcm9wX212aWV3cyhtdmlld3MsIChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2Ryb3AnLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5kcm9wX3RhYmxlKChlcnIyKSA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiZHJvcCcsIGVycjIpKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgY29uc3QgY3JlYXRlVGFibGVRdWVyeSA9IHRoaXMuX2NyZWF0ZV90YWJsZV9xdWVyeSh0YWJsZU5hbWUsIG1vZGVsU2NoZW1hKTtcbiAgICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjcmVhdGVUYWJsZVF1ZXJ5LCBbXSwgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhpcy5kcm9wX3RhYmxlKChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJkcm9wJywgZXJyMSkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBjcmVhdGVUYWJsZVF1ZXJ5ID0gdGhpcy5fY3JlYXRlX3RhYmxlX3F1ZXJ5KHRhYmxlTmFtZSwgbW9kZWxTY2hlbWEpO1xuICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjcmVhdGVUYWJsZVF1ZXJ5LCBbXSwgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IGFmdGVyREJBbHRlciA9IChlcnIxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgIGlmIChlcnIxLm1lc3NhZ2UgIT09ICdicmVhaycpIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBpdCBzaG91bGQgY3JlYXRlL2Ryb3AgaW5kZXhlcy9jdXN0b21faW5kZXhlcy9tYXRlcmlhbGl6ZWRfdmlld3MgdGhhdCBhcmUgYWRkZWQvcmVtb3ZlZCBpbiBtb2RlbCBzY2hlbWFcbiAgICAgICAgICAvLyByZW1vdmUgY29tbW9uIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZE1vZGVsU2NoZW1hIGFuZCBub3JtYWxpemVkREJTY2hlbWFcbiAgICAgICAgICAvLyB0aGVuIGRyb3AgYWxsIHJlbWFpbmluZyBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyBmcm9tIG5vcm1hbGl6ZWREQlNjaGVtYVxuICAgICAgICAgIC8vIGFuZCBhZGQgYWxsIHJlbWFpbmluZyBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyBmcm9tIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYVxuICAgICAgICAgIGNvbnN0IGFkZGVkSW5kZXhlcyA9IF8uZGlmZmVyZW5jZShub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcywgbm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMpO1xuICAgICAgICAgIGNvbnN0IHJlbW92ZWRJbmRleGVzID0gXy5kaWZmZXJlbmNlKG5vcm1hbGl6ZWREQlNjaGVtYS5pbmRleGVzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcyk7XG4gICAgICAgICAgY29uc3QgcmVtb3ZlZEluZGV4TmFtZXMgPSBbXTtcbiAgICAgICAgICByZW1vdmVkSW5kZXhlcy5mb3JFYWNoKChyZW1vdmVkSW5kZXgpID0+IHtcbiAgICAgICAgICAgIHJlbW92ZWRJbmRleE5hbWVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbcmVtb3ZlZEluZGV4XSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBjb25zdCBhZGRlZEN1c3RvbUluZGV4ZXMgPSBfLmZpbHRlcihcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcyxcbiAgICAgICAgICAgIChvYmopID0+ICghXy5maW5kKG5vcm1hbGl6ZWREQlNjaGVtYS5jdXN0b21faW5kZXhlcywgb2JqKSksXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCByZW1vdmVkQ3VzdG9tSW5kZXhlcyA9IF8uZmlsdGVyKFxuICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLFxuICAgICAgICAgICAgKG9iaikgPT4gKCFfLmZpbmQobm9ybWFsaXplZE1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBvYmopKSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHJlbW92ZWRDdXN0b21JbmRleGVzLmZvckVhY2goKHJlbW92ZWRJbmRleCkgPT4ge1xuICAgICAgICAgICAgcmVtb3ZlZEluZGV4TmFtZXMucHVzaChkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKHJlbW92ZWRJbmRleCldKTtcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IGFkZGVkTWF0ZXJpYWxpemVkVmlld3MgPSBfLmZpbHRlcihcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpLFxuICAgICAgICAgICAgKHZpZXdOYW1lKSA9PlxuICAgICAgICAgICAgICAoIV8uZmluZChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSkpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3QgcmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzID0gXy5maWx0ZXIoXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSxcbiAgICAgICAgICAgICh2aWV3TmFtZSkgPT5cbiAgICAgICAgICAgICAgKCFfLmZpbmQobm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cywgbm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV0pKSxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgLy8gcmVtb3ZlIGFsdGVyZWQgbWF0ZXJpYWxpemVkIHZpZXdzXG4gICAgICAgICAgaWYgKHJlbW92ZWRNYXRlcmlhbGl6ZWRWaWV3cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIHJlbW92ZWQgbWF0ZXJpYWxpemVkX3ZpZXdzOiAlaiwgZHJvcCB0aGVtPyAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzLFxuICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgIT09ICd5Jykge1xuICAgICAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlbW92ZWRJbmRleE5hbWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgcmVtb3ZlZCBpbmRleGVzOiAlaiwgZHJvcCB0aGVtPyAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZlZEluZGV4TmFtZXMsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSAhPT0gJ3knKSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuZHJvcF9tdmlld3MocmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdzLCAoZXJyMikgPT4ge1xuICAgICAgICAgICAgaWYgKGVycjIpIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3ZHJvcCcsIGVycjIpKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyByZW1vdmUgYWx0ZXJlZCBpbmRleGVzIGJ5IGluZGV4IG5hbWVcbiAgICAgICAgICAgIHRoaXMuZHJvcF9pbmRleGVzKHJlbW92ZWRJbmRleE5hbWVzLCAoZXJyMykgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyMykge1xuICAgICAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJpbmRleGRyb3AnLCBlcnIzKSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgLy8gYWRkIGFsdGVyZWQgaW5kZXhlc1xuICAgICAgICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGFkZGVkSW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSh0aGlzLl9jcmVhdGVfaW5kZXhfcXVlcnkodGFibGVOYW1lLCBpZHgpLCBbXSwgKGVycjQsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjQpIG5leHQoZXJyNCk7XG4gICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfSwgKGVycjQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyNCkge1xuICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyNCkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIGN1c3RvbSBpbmRleGVzXG4gICAgICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhhZGRlZEN1c3RvbUluZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGN1c3RvbUluZGV4UXVlcnkgPSB0aGlzLl9jcmVhdGVfY3VzdG9tX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KTtcbiAgICAgICAgICAgICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShjdXN0b21JbmRleFF1ZXJ5LCBbXSwgKGVycjUsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXJyNSkgbmV4dChlcnI1KTtcbiAgICAgICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9LCAoZXJyNSkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyNSkpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIG1hdGVyaWFsaXplZF92aWV3c1xuICAgICAgICAgICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhhZGRlZE1hdGVyaWFsaXplZFZpZXdzLCAodmlld05hbWUsIG5leHQpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Vmlld1F1ZXJ5ID0gdGhpcy5fY3JlYXRlX21hdGVyaWFsaXplZF92aWV3X3F1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICB2aWV3TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICBtb2RlbFNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbdmlld05hbWVdLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkobWF0Vmlld1F1ZXJ5LCBbXSwgKGVycjYsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnI2KSBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2NyZWF0ZScsIGVycjYpKTtcbiAgICAgICAgICAgICAgICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICB9LCBjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgYWx0ZXJEQlRhYmxlID0gKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGRpZmZlcmVuY2VzID0gZGVlcERpZmYobm9ybWFsaXplZERCU2NoZW1hLmZpZWxkcywgbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkcyk7XG4gICAgICAgICAgYXN5bmMuZWFjaFNlcmllcyhkaWZmZXJlbmNlcywgKGRpZmYsIG5leHQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGRpZmYucGF0aFswXTtcbiAgICAgICAgICAgIGNvbnN0IGFsdGVyRmllbGRUeXBlID0gKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgdHlwZSBmb3IgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICdhbHRlciB0YWJsZSB0byB1cGRhdGUgY29sdW1uIHR5cGU/ICh5L24pOiAnLFxuICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwZXJtaXNzaW9uLnRvTG93ZXJDYXNlKCkgPT09ICd5Jykge1xuICAgICAgICAgICAgICAgIHRoaXMuYWx0ZXJfdGFibGUoJ0FMVEVSJywgZmllbGROYW1lLCBkaWZmLnJocywgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKGVycjEpIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmFsdGVyJywgZXJyMSkpO1xuICAgICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGFsdGVyQWRkRmllbGQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgIGxldCB0eXBlID0gJyc7XG4gICAgICAgICAgICAgIGlmIChkaWZmLnBhdGgubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgICAgIGlmIChkaWZmLnBhdGhbMV0gPT09ICd0eXBlJykge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9IGRpZmYucmhzO1xuICAgICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlRGVmKSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgKz0gbm9ybWFsaXplZE1vZGVsU2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGVEZWY7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHR5cGUgPSBub3JtYWxpemVkTW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZTtcbiAgICAgICAgICAgICAgICAgIHR5cGUgKz0gZGlmZi5yaHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBkaWZmLnJocy50eXBlO1xuICAgICAgICAgICAgICAgIGlmIChkaWZmLnJocy50eXBlRGVmKSB0eXBlICs9IGRpZmYucmhzLnR5cGVEZWY7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICB0aGlzLmFsdGVyX3RhYmxlKCdBREQnLCBmaWVsZE5hbWUsIHR5cGUsIChlcnIxLCByZXN1bHQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiYWx0ZXInLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgY29uc3QgYWx0ZXJSZW1vdmVGaWVsZCA9IChuZXh0Q2FsbGJhY2spID0+IHtcbiAgICAgICAgICAgICAgLy8gcmVtb3ZlIGRlcGVuZGVudCBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyxcbiAgICAgICAgICAgICAgLy8gdXBkYXRlIHRoZW0gaW4gbm9ybWFsaXplZERCU2NoZW1hLCB0aGVuIGFsdGVyXG4gICAgICAgICAgICAgIGNvbnN0IGRlcGVuZGVudEluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgY29uc3QgcHVsbEluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMuZm9yRWFjaCgoZGJJbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGluZGV4U3BsaXQgPSBkYkluZGV4LnNwbGl0KC9bKCldL2cpO1xuICAgICAgICAgICAgICAgIGxldCBpbmRleEZpZWxkTmFtZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleFNwbGl0Lmxlbmd0aCA+IDEpIGluZGV4RmllbGROYW1lID0gaW5kZXhTcGxpdFsxXTtcbiAgICAgICAgICAgICAgICBlbHNlIGluZGV4RmllbGROYW1lID0gaW5kZXhTcGxpdFswXTtcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXhGaWVsZE5hbWUgPT09IGZpZWxkTmFtZSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50SW5kZXhlcy5wdXNoKGRiU2NoZW1hLmluZGV4X25hbWVzW2RiSW5kZXhdKTtcbiAgICAgICAgICAgICAgICAgIHB1bGxJbmRleGVzLnB1c2goZGJJbmRleCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgXy5wdWxsQWxsKG5vcm1hbGl6ZWREQlNjaGVtYS5pbmRleGVzLCBwdWxsSW5kZXhlcyk7XG5cbiAgICAgICAgICAgICAgY29uc3QgcHVsbEN1c3RvbUluZGV4ZXMgPSBbXTtcbiAgICAgICAgICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLmZvckVhY2goKGRiSW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZGJJbmRleC5vbiA9PT0gZmllbGROYW1lKSB7XG4gICAgICAgICAgICAgICAgICBkZXBlbmRlbnRJbmRleGVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbb2JqZWN0SGFzaChkYkluZGV4KV0pO1xuICAgICAgICAgICAgICAgICAgcHVsbEN1c3RvbUluZGV4ZXMucHVzaChkYkluZGV4KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBfLnB1bGxBbGwobm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBwdWxsQ3VzdG9tSW5kZXhlcyk7XG5cbiAgICAgICAgICAgICAgY29uc3QgZGVwZW5kZW50Vmlld3MgPSBbXTtcbiAgICAgICAgICAgICAgT2JqZWN0LmtleXMobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykuZm9yRWFjaCgoZGJWaWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLnNlbGVjdC5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0uc2VsZWN0WzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgIGRlcGVuZGVudFZpZXdzLnB1c2goZGJWaWV3TmFtZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLmtleS5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3NbZGJWaWV3TmFtZV0ua2V5WzBdIGluc3RhbmNlb2YgQXJyYXlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAmJiBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW2RiVmlld05hbWVdLmtleVswXS5pbmRleE9mKGZpZWxkTmFtZSkgPiAtMSkge1xuICAgICAgICAgICAgICAgICAgZGVwZW5kZW50Vmlld3MucHVzaChkYlZpZXdOYW1lKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBkZXBlbmRlbnRWaWV3cy5mb3JFYWNoKCh2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXTtcbiAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgdGhpcy5kcm9wX212aWV3cyhkZXBlbmRlbnRWaWV3cywgKGVycjEpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyMSkge1xuICAgICAgICAgICAgICAgICAgbmV4dENhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24ubWF0dmlld2Ryb3AnLCBlcnIxKSk7XG4gICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5kcm9wX2luZGV4ZXMoZGVwZW5kZW50SW5kZXhlcywgKGVycjIpID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmIChlcnIyKSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHRDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhkcm9wJywgZXJyMikpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgIHRoaXMuYWx0ZXJfdGFibGUoJ0RST1AnLCBmaWVsZE5hbWUsICcnLCAoZXJyMywgcmVzdWx0KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnIzKSBuZXh0Q2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmFsdGVyJywgZXJyMykpO1xuICAgICAgICAgICAgICAgICAgICBlbHNlIG5leHRDYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKGRpZmYua2luZCA9PT0gJ04nKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIGFkZGVkIGZpZWxkIFwiJXNcIiwgYWx0ZXIgdGFibGUgdG8gYWRkIGNvbHVtbj8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgYWx0ZXJBZGRGaWVsZCgpO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGRpZmYua2luZCA9PT0gJ0QnKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9hc2tfY29uZmlybWF0aW9uKFxuICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIHJlbW92ZWQgZmllbGQgXCIlc1wiLCBhbHRlciB0YWJsZSB0byBkcm9wIGNvbHVtbj8gJyArXG4gICAgICAgICAgICAgICAgICAnKGNvbHVtbiBkYXRhIHdpbGwgYmUgbG9zdCAmIGRlcGVuZGVudCBpbmRleGVzL3ZpZXdzIHdpbGwgYmUgcmVjcmVhdGVkISkgKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgYWx0ZXJSZW1vdmVGaWVsZChuZXh0KTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChkaWZmLmtpbmQgPT09ICdFJykge1xuICAgICAgICAgICAgICAvLyBjaGVjayBpZiB0aGUgYWx0ZXIgZmllbGQgdHlwZSBpcyBwb3NzaWJsZSwgb3RoZXJ3aXNlIHRyeSBEIGFuZCB0aGVuIE5cbiAgICAgICAgICAgICAgaWYgKGRpZmYucGF0aFsxXSA9PT0gJ3R5cGUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRpZmYubGhzID09PSAnaW50JyAmJiBkaWZmLnJocyA9PT0gJ3ZhcmludCcpIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGFsdGVyRmllbGRUeXBlKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEua2V5LmluZGV4T2YoZmllbGROYW1lKSA+IDApIHsgLy8gY2hlY2sgaWYgZmllbGQgcGFydCBvZiBjbHVzdGVyaW5nIGtleVxuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBpbXBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyBpbmNvbXBhdGlibGUgdHlwZSBmb3IgcHJpbWFyeSBrZXkgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICAgICAncHJvY2VlZCB0byByZWNyZWF0ZSB0YWJsZT8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChuZXcgRXJyb3IoJ2JyZWFrJykpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChbJ3RleHQnLCAnYXNjaWknLCAnYmlnaW50JywgJ2Jvb2xlYW4nLCAnZGVjaW1hbCcsXG4gICAgICAgICAgICAgICAgICAnZG91YmxlJywgJ2Zsb2F0JywgJ2luZXQnLCAnaW50JywgJ3RpbWVzdGFtcCcsICd0aW1ldXVpZCcsXG4gICAgICAgICAgICAgICAgICAndXVpZCcsICd2YXJjaGFyJywgJ3ZhcmludCddLmluZGV4T2YoZGlmZi5saHMpID4gLTEgJiYgZGlmZi5yaHMgPT09ICdibG9iJykge1xuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBwb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgYWx0ZXJGaWVsZFR5cGUoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpZmYubGhzID09PSAndGltZXV1aWQnICYmIGRpZmYucmhzID09PSAndXVpZCcpIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgICAgICAgIGFsdGVyRmllbGRUeXBlKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxpemVkREJTY2hlbWEua2V5WzBdLmluZGV4T2YoZmllbGROYW1lKSA+IC0xKSB7IC8vIGNoZWNrIGlmIGZpZWxkIHBhcnQgb2YgcGFydGl0aW9uIGtleVxuICAgICAgICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBpbXBvc3NpYmxlXG4gICAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICAgICAgJ01pZ3JhdGlvbjogbW9kZWwgc2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyBpbmNvbXBhdGlibGUgdHlwZSBmb3IgcHJpbWFyeSBrZXkgZmllbGQgXCIlc1wiLCAnICtcbiAgICAgICAgICAgICAgICAgICAgICAncHJvY2VlZCB0byByZWNyZWF0ZSB0YWJsZT8gKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChuZXcgRXJyb3IoJ2JyZWFrJykpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIC8vIGFsdGVyIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2Fza19jb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAgICdNaWdyYXRpb246IG1vZGVsIHNjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgaW5jb21wYXRpYmxlIHR5cGUgZm9yIGZpZWxkIFwiJXNcIiwgZHJvcCBjb2x1bW4gJyArXG4gICAgICAgICAgICAgICAgICAgICAgJ2FuZCByZWNyZWF0ZT8gKGNvbHVtbiBkYXRhIHdpbGwgYmUgbG9zdCAmIGRlcGVuZGVudCBpbmRleGVzL3ZpZXdzIHdpbGwgYmUgcmVjcmVhdGVkISkgKHkvbik6ICcsXG4gICAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBpZiAocGVybWlzc2lvbi50b0xvd2VyQ2FzZSgpID09PSAneScpIHtcbiAgICAgICAgICAgICAgICAgICAgYWx0ZXJSZW1vdmVGaWVsZCgoZXJyMSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIxKSBuZXh0KGVycjEpO1xuICAgICAgICAgICAgICAgICAgICAgIGVsc2UgYWx0ZXJBZGRGaWVsZCgpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBhbHRlciB0eXBlIGltcG9zc2libGVcbiAgICAgICAgICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gdGhpcy5fYXNrX2NvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgIHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgICAnTWlncmF0aW9uOiBtb2RlbCBzY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgbmV3IGluY29tcGF0aWJsZSB0eXBlIGZvciBmaWVsZCBcIiVzXCIsIGRyb3AgY29sdW1uICcgK1xuICAgICAgICAgICAgICAgICAgICAnYW5kIHJlY3JlYXRlPyAoY29sdW1uIGRhdGEgd2lsbCBiZSBsb3N0ICYgZGVwZW5kZW50IGluZGV4ZXMvdmlld3Mgd2lsbCBiZSByZWNyZWF0ZWQhKSAoeS9uKTogJyxcbiAgICAgICAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgaWYgKHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKSA9PT0gJ3knKSB7XG4gICAgICAgICAgICAgICAgICBhbHRlclJlbW92ZUZpZWxkKChlcnIxKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnIxKSBuZXh0KGVycjEpO1xuICAgICAgICAgICAgICAgICAgICBlbHNlIGFsdGVyQWRkRmllbGQoKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LCBhZnRlckRCQWx0ZXIpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGlmIChtaWdyYXRpb24gPT09ICdhbHRlcicpIHtcbiAgICAgICAgICAvLyBjaGVjayBpZiB0YWJsZSBjYW4gYmUgYWx0ZXJlZCB0byBtYXRjaCBzY2hlbWFcbiAgICAgICAgICBpZiAoXy5pc0VxdWFsKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5rZXksIG5vcm1hbGl6ZWREQlNjaGVtYS5rZXkpICYmXG4gICAgICAgICAgICBfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXIsIG5vcm1hbGl6ZWREQlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSkge1xuICAgICAgICAgICAgYWx0ZXJEQlRhYmxlKCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRyb3BSZWNyZWF0ZVRhYmxlKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG1pZ3JhdGlvbiA9PT0gJ2Ryb3AnKSB7XG4gICAgICAgICAgZHJvcFJlY3JlYXRlVGFibGUoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gaWYgbm90IGV4aXN0aW5nLCBpdCdzIGNyZWF0ZWRcbiAgICAgIGNvbnN0IGNyZWF0ZVRhYmxlUXVlcnkgPSB0aGlzLl9jcmVhdGVfdGFibGVfcXVlcnkodGFibGVOYW1lLCBtb2RlbFNjaGVtYSk7XG4gICAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkoY3JlYXRlVGFibGVRdWVyeSwgW10sIGFmdGVyREJDcmVhdGUpO1xuICAgIH1cbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV90YWJsZV9xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCBzY2hlbWEpIHtcbiAgY29uc3Qgcm93cyA9IFtdO1xuICBsZXQgZmllbGRUeXBlO1xuICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKChrKSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNba10udmlydHVhbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgc2VnbWVudCA9ICcnO1xuICAgIGZpZWxkVHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBrKTtcbiAgICBpZiAoc2NoZW1hLmZpZWxkc1trXS50eXBlRGVmKSB7XG4gICAgICBzZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAlcyVzJywgaywgZmllbGRUeXBlLCBzY2hlbWEuZmllbGRzW2tdLnR5cGVEZWYpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAlcycsIGssIGZpZWxkVHlwZSk7XG4gICAgfVxuXG4gICAgaWYgKHNjaGVtYS5maWVsZHNba10uc3RhdGljKSB7XG4gICAgICBzZWdtZW50ICs9ICcgU1RBVElDJztcbiAgICB9XG5cbiAgICByb3dzLnB1c2goc2VnbWVudCk7XG4gIH0pO1xuXG4gIGxldCBwYXJ0aXRpb25LZXkgPSBzY2hlbWEua2V5WzBdO1xuICBsZXQgY2x1c3RlcmluZ0tleSA9IHNjaGVtYS5rZXkuc2xpY2UoMSwgc2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuXG4gIGZvciAobGV0IGZpZWxkID0gMDsgZmllbGQgPCBjbHVzdGVyaW5nS2V5Lmxlbmd0aDsgZmllbGQrKykge1xuICAgIGlmIChzY2hlbWEuY2x1c3RlcmluZ19vcmRlclxuICAgICAgICAmJiBzY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgc2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbY2x1c3RlcmluZ0tleVtmaWVsZF1dLnRvTG93ZXJDYXNlKCkgPT09ICdkZXNjJykge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBERVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2x1c3RlcmluZ09yZGVyLnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIiBBU0MnLCBjbHVzdGVyaW5nS2V5W2ZpZWxkXSkpO1xuICAgIH1cbiAgfVxuXG4gIGxldCBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9ICcnO1xuICBpZiAoY2x1c3RlcmluZ09yZGVyLmxlbmd0aCA+IDApIHtcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSA9IHV0aWwuZm9ybWF0KCcgV0lUSCBDTFVTVEVSSU5HIE9SREVSIEJZICglcyknLCBjbHVzdGVyaW5nT3JkZXIudG9TdHJpbmcoKSk7XG4gIH1cblxuICBpZiAocGFydGl0aW9uS2V5IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBwYXJ0aXRpb25LZXkgPSBwYXJ0aXRpb25LZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRpdGlvbktleSA9IHV0aWwuZm9ybWF0KCdcIiVzXCInLCBwYXJ0aXRpb25LZXkpO1xuICB9XG5cbiAgaWYgKGNsdXN0ZXJpbmdLZXkubGVuZ3RoKSB7XG4gICAgY2x1c3RlcmluZ0tleSA9IGNsdXN0ZXJpbmdLZXkubWFwKCh2KSA9PiAodXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKSkuam9pbignLCcpO1xuICAgIGNsdXN0ZXJpbmdLZXkgPSB1dGlsLmZvcm1hdCgnLCVzJywgY2x1c3RlcmluZ0tleSk7XG4gIH0gZWxzZSB7XG4gICAgY2x1c3RlcmluZ0tleSA9ICcnO1xuICB9XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgXCIlc1wiICglcyAsIFBSSU1BUlkgS0VZKCglcyklcykpJXM7JyxcbiAgICB0YWJsZU5hbWUsXG4gICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICBwYXJ0aXRpb25LZXksXG4gICAgY2x1c3RlcmluZ0tleSxcbiAgICBjbHVzdGVyaW5nT3JkZXJRdWVyeSxcbiAgKTtcblxuICByZXR1cm4gcXVlcnk7XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCB2aWV3TmFtZSwgdmlld1NjaGVtYSkge1xuICBjb25zdCByb3dzID0gW107XG5cbiAgZm9yIChsZXQgayA9IDA7IGsgPCB2aWV3U2NoZW1hLnNlbGVjdC5sZW5ndGg7IGsrKykge1xuICAgIGlmICh2aWV3U2NoZW1hLnNlbGVjdFtrXSA9PT0gJyonKSByb3dzLnB1c2godXRpbC5mb3JtYXQoJyVzJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgICBlbHNlIHJvd3MucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgfVxuXG4gIGxldCBwYXJ0aXRpb25LZXkgPSB2aWV3U2NoZW1hLmtleVswXTtcbiAgbGV0IGNsdXN0ZXJpbmdLZXkgPSB2aWV3U2NoZW1hLmtleS5zbGljZSgxLCB2aWV3U2NoZW1hLmtleS5sZW5ndGgpO1xuICBjb25zdCBjbHVzdGVyaW5nT3JkZXIgPSBbXTtcblxuICBmb3IgKGxldCBmaWVsZCA9IDA7IGZpZWxkIDwgY2x1c3RlcmluZ0tleS5sZW5ndGg7IGZpZWxkKyspIHtcbiAgICBpZiAodmlld1NjaGVtYS5jbHVzdGVyaW5nX29yZGVyXG4gICAgICAgICYmIHZpZXdTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltjbHVzdGVyaW5nS2V5W2ZpZWxkXV1cbiAgICAgICAgJiYgdmlld1NjaGVtYS5jbHVzdGVyaW5nX29yZGVyW2NsdXN0ZXJpbmdLZXlbZmllbGRdXS50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgREVTQycsIGNsdXN0ZXJpbmdLZXlbZmllbGRdKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNsdXN0ZXJpbmdPcmRlci5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgQVNDJywgY2x1c3RlcmluZ0tleVtmaWVsZF0pKTtcbiAgICB9XG4gIH1cblxuICBsZXQgY2x1c3RlcmluZ09yZGVyUXVlcnkgPSAnJztcbiAgaWYgKGNsdXN0ZXJpbmdPcmRlci5sZW5ndGggPiAwKSB7XG4gICAgY2x1c3RlcmluZ09yZGVyUXVlcnkgPSB1dGlsLmZvcm1hdCgnIFdJVEggQ0xVU1RFUklORyBPUkRFUiBCWSAoJXMpJywgY2x1c3RlcmluZ09yZGVyLnRvU3RyaW5nKCkpO1xuICB9XG5cbiAgaWYgKHBhcnRpdGlvbktleSBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgcGFydGl0aW9uS2V5ID0gcGFydGl0aW9uS2V5Lm1hcCgodikgPT4gdXRpbC5mb3JtYXQoJ1wiJXNcIicsIHYpKS5qb2luKCcsJyk7XG4gIH0gZWxzZSB7XG4gICAgcGFydGl0aW9uS2V5ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIicsIHBhcnRpdGlvbktleSk7XG4gIH1cblxuICBpZiAoY2x1c3RlcmluZ0tleS5sZW5ndGgpIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gY2x1c3RlcmluZ0tleS5tYXAoKHYpID0+ICh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdikpKS5qb2luKCcsJyk7XG4gICAgY2x1c3RlcmluZ0tleSA9IHV0aWwuZm9ybWF0KCcsJXMnLCBjbHVzdGVyaW5nS2V5KTtcbiAgfSBlbHNlIHtcbiAgICBjbHVzdGVyaW5nS2V5ID0gJyc7XG4gIH1cblxuICBsZXQgd2hlcmVDbGF1c2UgPSBwYXJ0aXRpb25LZXkuc3BsaXQoJywnKS5qb2luKCcgSVMgTk9UIE5VTEwgQU5EICcpO1xuICBpZiAoY2x1c3RlcmluZ0tleSkgd2hlcmVDbGF1c2UgKz0gY2x1c3RlcmluZ0tleS5zcGxpdCgnLCcpLmpvaW4oJyBJUyBOT1QgTlVMTCBBTkQgJyk7XG4gIHdoZXJlQ2xhdXNlICs9ICcgSVMgTk9UIE5VTEwnO1xuXG4gIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0NSRUFURSBNQVRFUklBTElaRUQgVklFVyBJRiBOT1QgRVhJU1RTIFwiJXNcIiBBUyBTRUxFQ1QgJXMgRlJPTSBcIiVzXCIgV0hFUkUgJXMgUFJJTUFSWSBLRVkoKCVzKSVzKSVzOycsXG4gICAgdmlld05hbWUsXG4gICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICB0YWJsZU5hbWUsXG4gICAgd2hlcmVDbGF1c2UsXG4gICAgcGFydGl0aW9uS2V5LFxuICAgIGNsdXN0ZXJpbmdLZXksXG4gICAgY2x1c3RlcmluZ09yZGVyUXVlcnksXG4gICk7XG5cbiAgcmV0dXJuIHF1ZXJ5O1xufTtcblxuQmFzZU1vZGVsLl9jcmVhdGVfaW5kZXhfcXVlcnkgPSBmdW5jdGlvbiBmKHRhYmxlTmFtZSwgaW5kZXhOYW1lKSB7XG4gIGxldCBxdWVyeTtcbiAgY29uc3QgaW5kZXhFeHByZXNzaW9uID0gaW5kZXhOYW1lLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICBpZiAoaW5kZXhFeHByZXNzaW9uLmxlbmd0aCA+IDEpIHtcbiAgICBpbmRleEV4cHJlc3Npb25bMF0gPSBpbmRleEV4cHJlc3Npb25bMF0udG9Mb3dlckNhc2UoKTtcbiAgICBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoJXMoXCIlc1wiKSk7JyxcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGluZGV4RXhwcmVzc2lvblswXSxcbiAgICAgIGluZGV4RXhwcmVzc2lvblsxXSxcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgT04gXCIlc1wiIChcIiVzXCIpOycsXG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBpbmRleEV4cHJlc3Npb25bMF0sXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBxdWVyeTtcbn07XG5cbkJhc2VNb2RlbC5fY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSA9IGZ1bmN0aW9uIGYodGFibGVOYW1lLCBjdXN0b21JbmRleCkge1xuICBsZXQgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAnQ1JFQVRFIENVU1RPTSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoXCIlc1wiKSBVU0lORyBcXCclc1xcJycsXG4gICAgdGFibGVOYW1lLFxuICAgIGN1c3RvbUluZGV4Lm9uLFxuICAgIGN1c3RvbUluZGV4LnVzaW5nLFxuICApO1xuXG4gIGlmIChPYmplY3Qua2V5cyhjdXN0b21JbmRleC5vcHRpb25zKS5sZW5ndGggPiAwKSB7XG4gICAgcXVlcnkgKz0gJyBXSVRIIE9QVElPTlMgPSB7JztcbiAgICBPYmplY3Qua2V5cyhjdXN0b21JbmRleC5vcHRpb25zKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KFwiJyVzJzogJyVzJywgXCIsIGtleSwgY3VzdG9tSW5kZXgub3B0aW9uc1trZXldKTtcbiAgICB9KTtcbiAgICBxdWVyeSA9IHF1ZXJ5LnNsaWNlKDAsIC0yKTtcbiAgICBxdWVyeSArPSAnfSc7XG4gIH1cblxuICBxdWVyeSArPSAnOyc7XG5cbiAgcmV0dXJuIHF1ZXJ5O1xufTtcblxuQmFzZU1vZGVsLl9nZXRfZGJfdGFibGVfc2NoZW1hID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICBjb25zdCBzZWxmID0gdGhpcztcblxuICBjb25zdCB0YWJsZU5hbWUgPSB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fcHJvcGVydGllcy5rZXlzcGFjZTtcblxuICBsZXQgcXVlcnkgPSAnU0VMRUNUICogRlJPTSBzeXN0ZW1fc2NoZW1hLmNvbHVtbnMgV0hFUkUgdGFibGVfbmFtZSA9ID8gQU5EIGtleXNwYWNlX25hbWUgPSA/Oyc7XG5cbiAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBbdGFibGVOYW1lLCBrZXlzcGFjZV0sIChlcnIsIHJlc3VsdENvbHVtbnMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXJlc3VsdENvbHVtbnMucm93cyB8fCByZXN1bHRDb2x1bW5zLnJvd3MubGVuZ3RoID09PSAwKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBudWxsKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBkYlNjaGVtYSA9IHsgZmllbGRzOiB7fSwgdHlwZU1hcHM6IHt9LCBzdGF0aWNNYXBzOiB7fSB9O1xuXG4gICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRDb2x1bW5zLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgIGNvbnN0IHJvdyA9IHJlc3VsdENvbHVtbnMucm93c1tyXTtcblxuICAgICAgZGJTY2hlbWEuZmllbGRzW3Jvdy5jb2x1bW5fbmFtZV0gPSBUWVBFX01BUC5leHRyYWN0X3R5cGUocm93LnR5cGUpO1xuXG4gICAgICBjb25zdCB0eXBlTWFwRGVmID0gVFlQRV9NQVAuZXh0cmFjdF90eXBlRGVmKHJvdy50eXBlKTtcbiAgICAgIGlmICh0eXBlTWFwRGVmLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZGJTY2hlbWEudHlwZU1hcHNbcm93LmNvbHVtbl9uYW1lXSA9IHR5cGVNYXBEZWY7XG4gICAgICB9XG5cbiAgICAgIGlmIChyb3cua2luZCA9PT0gJ3BhcnRpdGlvbl9rZXknKSB7XG4gICAgICAgIGlmICghZGJTY2hlbWEua2V5KSBkYlNjaGVtYS5rZXkgPSBbW11dO1xuICAgICAgICBkYlNjaGVtYS5rZXlbMF1bcm93LnBvc2l0aW9uXSA9IHJvdy5jb2x1bW5fbmFtZTtcbiAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICBpZiAoIWRiU2NoZW1hLmtleSkgZGJTY2hlbWEua2V5ID0gW1tdXTtcbiAgICAgICAgaWYgKCFkYlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSBkYlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyID0ge307XG5cbiAgICAgICAgZGJTY2hlbWEua2V5W3Jvdy5wb3NpdGlvbiArIDFdID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICBpZiAocm93LmNsdXN0ZXJpbmdfb3JkZXIgJiYgcm93LmNsdXN0ZXJpbmdfb3JkZXIudG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICAgICAgZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0RFU0MnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRiU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdBU0MnO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHJvdy5raW5kID09PSAnc3RhdGljJykge1xuICAgICAgICBkYlNjaGVtYS5zdGF0aWNNYXBzW3Jvdy5jb2x1bW5fbmFtZV0gPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHF1ZXJ5ID0gJ1NFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5pbmRleGVzIFdIRVJFIHRhYmxlX25hbWUgPSA/IEFORCBrZXlzcGFjZV9uYW1lID0gPzsnO1xuXG4gICAgc2VsZi5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBbdGFibGVOYW1lLCBrZXlzcGFjZV0sIChlcnIxLCByZXN1bHRJbmRleGVzKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIxKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRJbmRleGVzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0SW5kZXhlcy5yb3dzW3JdO1xuXG4gICAgICAgIGlmIChyb3cuaW5kZXhfbmFtZSkge1xuICAgICAgICAgIGNvbnN0IGluZGV4T3B0aW9ucyA9IHJvdy5vcHRpb25zO1xuICAgICAgICAgIGxldCB0YXJnZXQgPSBpbmRleE9wdGlvbnMudGFyZ2V0O1xuICAgICAgICAgIHRhcmdldCA9IHRhcmdldC5yZXBsYWNlKC9bXCJcXHNdL2csICcnKTtcbiAgICAgICAgICBkZWxldGUgaW5kZXhPcHRpb25zLnRhcmdldDtcblxuICAgICAgICAgIC8vIGtlZXBpbmcgdHJhY2sgb2YgaW5kZXggbmFtZXMgdG8gZHJvcCBpbmRleCB3aGVuIG5lZWRlZFxuICAgICAgICAgIGlmICghZGJTY2hlbWEuaW5kZXhfbmFtZXMpIGRiU2NoZW1hLmluZGV4X25hbWVzID0ge307XG5cbiAgICAgICAgICBpZiAocm93LmtpbmQgPT09ICdDVVNUT00nKSB7XG4gICAgICAgICAgICBjb25zdCB1c2luZyA9IGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuXG4gICAgICAgICAgICBpZiAoIWRiU2NoZW1hLmN1c3RvbV9pbmRleGVzKSBkYlNjaGVtYS5jdXN0b21faW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tSW5kZXhPYmplY3QgPSB7XG4gICAgICAgICAgICAgIG9uOiB0YXJnZXQsXG4gICAgICAgICAgICAgIHVzaW5nLFxuICAgICAgICAgICAgICBvcHRpb25zOiBpbmRleE9wdGlvbnMsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgZGJTY2hlbWEuY3VzdG9tX2luZGV4ZXMucHVzaChjdXN0b21JbmRleE9iamVjdCk7XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKGN1c3RvbUluZGV4T2JqZWN0KV0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5pbmRleGVzKSBkYlNjaGVtYS5pbmRleGVzID0gW107XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleGVzLnB1c2godGFyZ2V0KTtcbiAgICAgICAgICAgIGRiU2NoZW1hLmluZGV4X25hbWVzW3RhcmdldF0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcXVlcnkgPSAnU0VMRUNUIHZpZXdfbmFtZSxiYXNlX3RhYmxlX25hbWUgRlJPTSBzeXN0ZW1fc2NoZW1hLnZpZXdzIFdIRVJFIGtleXNwYWNlX25hbWU9PzsnO1xuXG4gICAgICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFtrZXlzcGFjZV0sIChlcnIyLCByZXN1bHRWaWV3cykgPT4ge1xuICAgICAgICBpZiAoZXJyMikge1xuICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycjIpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdFZpZXdzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgICBjb25zdCByb3cgPSByZXN1bHRWaWV3cy5yb3dzW3JdO1xuXG4gICAgICAgICAgaWYgKHJvdy5iYXNlX3RhYmxlX25hbWUgPT09IHRhYmxlTmFtZSkge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MpIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyA9IHt9O1xuICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy52aWV3X25hbWVdID0ge307XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICAgIHF1ZXJ5ID0gJ1NFTEVDVCAqIEZST00gc3lzdGVtX3NjaGVtYS5jb2x1bW5zIFdIRVJFIGtleXNwYWNlX25hbWU9PyBhbmQgdGFibGVfbmFtZSBJTiA/Oyc7XG5cbiAgICAgICAgICBzZWxmLmV4ZWN1dGVfcXVlcnkocXVlcnksIFtrZXlzcGFjZSwgT2JqZWN0LmtleXMoZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKV0sIChlcnIzLCByZXN1bHRNYXRWaWV3cykgPT4ge1xuICAgICAgICAgICAgaWYgKGVycjMpIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYnNjaGVtYXF1ZXJ5JywgZXJyMykpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAobGV0IHIgPSAwOyByIDwgcmVzdWx0TWF0Vmlld3Mucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgICAgICAgICBjb25zdCByb3cgPSByZXN1bHRNYXRWaWV3cy5yb3dzW3JdO1xuXG4gICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QpIHtcbiAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLnNlbGVjdCA9IFtdO1xuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QucHVzaChyb3cuY29sdW1uX25hbWUpO1xuXG4gICAgICAgICAgICAgIGlmIChyb3cua2luZCA9PT0gJ3BhcnRpdGlvbl9rZXknKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleSkge1xuICAgICAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkgPSBbW11dO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5WzBdW3Jvdy5wb3NpdGlvbl0gPSByb3cuY29sdW1uX25hbWU7XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5ID0gW1tdXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXIpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlciA9IHt9O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0ua2V5W3Jvdy5wb3NpdGlvbiArIDFdID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICAgICAgICAgIGlmIChyb3cuY2x1c3RlcmluZ19vcmRlciAmJiByb3cuY2x1c3RlcmluZ19vcmRlci50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0RFU0MnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdBU0MnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYWxsYmFjayhudWxsLCBkYlNjaGVtYSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgZGJTY2hlbWEpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfcXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBjb25zdCBkb0V4ZWN1dGVRdWVyeSA9IGZ1bmN0aW9uIGYxKGRvcXVlcnksIGRvY2FsbGJhY2spIHtcbiAgICB0aGlzLmV4ZWN1dGVfcXVlcnkoZG9xdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBkb2NhbGxiYWNrKTtcbiAgfS5iaW5kKHRoaXMsIHF1ZXJ5KTtcblxuICBpZiAodGhpcy5pc190YWJsZV9yZWFkeSgpKSB7XG4gICAgZG9FeGVjdXRlUXVlcnkoY2FsbGJhY2spO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuaW5pdCgoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGRvRXhlY3V0ZVF1ZXJ5KGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbiA9IGZ1bmN0aW9uIGYoZmllbGRuYW1lLCBmaWVsZHZhbHVlKSB7XG4gIGlmIChmaWVsZHZhbHVlID09IG51bGwgfHwgZmllbGR2YWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgcmV0dXJuIHsgcXVlcnlfc2VnbWVudDogJz8nLCBwYXJhbWV0ZXI6IGZpZWxkdmFsdWUgfTtcbiAgfVxuXG4gIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGR2YWx1ZSkgJiYgZmllbGR2YWx1ZS4kZGJfZnVuY3Rpb24pIHtcbiAgICByZXR1cm4gZmllbGR2YWx1ZS4kZGJfZnVuY3Rpb247XG4gIH1cblxuICBjb25zdCBmaWVsZHR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hLCBmaWVsZG5hbWUpO1xuICBjb25zdCB2YWxpZGF0b3JzID0gdGhpcy5fZ2V0X3ZhbGlkYXRvcnMoZmllbGRuYW1lKTtcblxuICBpZiAoZmllbGR2YWx1ZSBpbnN0YW5jZW9mIEFycmF5ICYmIGZpZWxkdHlwZSAhPT0gJ2xpc3QnICYmIGZpZWxkdHlwZSAhPT0gJ3NldCcgJiYgZmllbGR0eXBlICE9PSAnZnJvemVuJykge1xuICAgIGNvbnN0IHZhbCA9IGZpZWxkdmFsdWUubWFwKCh2KSA9PiB7XG4gICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGZpZWxkbmFtZSwgdik7XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHJldHVybiBkYlZhbC5wYXJhbWV0ZXI7XG4gICAgICByZXR1cm4gZGJWYWw7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiAnPycsIHBhcmFtZXRlcjogdmFsIH07XG4gIH1cblxuICBjb25zdCB2YWxpZGF0aW9uTWVzc2FnZSA9IHRoaXMuX3ZhbGlkYXRlKHZhbGlkYXRvcnMsIGZpZWxkdmFsdWUpO1xuICBpZiAodmFsaWRhdGlvbk1lc3NhZ2UgIT09IHRydWUpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR2YWx1ZScsIHZhbGlkYXRpb25NZXNzYWdlKGZpZWxkdmFsdWUsIGZpZWxkbmFtZSwgZmllbGR0eXBlKSkpO1xuICB9XG5cbiAgaWYgKGZpZWxkdHlwZSA9PT0gJ2NvdW50ZXInKSB7XG4gICAgbGV0IGNvdW50ZXJRdWVyeVNlZ21lbnQgPSB1dGlsLmZvcm1hdCgnXCIlc1wiJywgZmllbGRuYW1lKTtcbiAgICBpZiAoZmllbGR2YWx1ZSA+PSAwKSBjb3VudGVyUXVlcnlTZWdtZW50ICs9ICcgKyA/JztcbiAgICBlbHNlIGNvdW50ZXJRdWVyeVNlZ21lbnQgKz0gJyAtID8nO1xuICAgIGZpZWxkdmFsdWUgPSBNYXRoLmFicyhmaWVsZHZhbHVlKTtcbiAgICByZXR1cm4geyBxdWVyeV9zZWdtZW50OiBjb3VudGVyUXVlcnlTZWdtZW50LCBwYXJhbWV0ZXI6IGZpZWxkdmFsdWUgfTtcbiAgfVxuXG4gIHJldHVybiB7IHF1ZXJ5X3NlZ21lbnQ6ICc/JywgcGFyYW1ldGVyOiBmaWVsZHZhbHVlIH07XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV93aGVyZV9jbGF1c2UgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0KSB7XG4gIGNvbnN0IHF1ZXJ5UmVsYXRpb25zID0gW107XG4gIGNvbnN0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgT2JqZWN0LmtleXMocXVlcnlPYmplY3QpLmZvckVhY2goKGspID0+IHtcbiAgICBpZiAoay5pbmRleE9mKCckJykgPT09IDApIHtcbiAgICAgIC8vIHNlYXJjaCBxdWVyaWVzIGJhc2VkIG9uIGx1Y2VuZSBpbmRleCBvciBzb2xyXG4gICAgICAvLyBlc2NhcGUgYWxsIHNpbmdsZSBxdW90ZXMgZm9yIHF1ZXJpZXMgaW4gY2Fzc2FuZHJhXG4gICAgICBpZiAoayA9PT0gJyRleHByJykge1xuICAgICAgICBpZiAodHlwZW9mIHF1ZXJ5T2JqZWN0W2tdLmluZGV4ID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgcXVlcnlPYmplY3Rba10ucXVlcnkgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwiZXhwciglcywnJXMnKVwiLFxuICAgICAgICAgICAgcXVlcnlPYmplY3Rba10uaW5kZXgsIHF1ZXJ5T2JqZWN0W2tdLnF1ZXJ5LnJlcGxhY2UoLycvZywgXCInJ1wiKSxcbiAgICAgICAgICApKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkZXhwcicpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChrID09PSAnJHNvbHJfcXVlcnknKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcXVlcnlPYmplY3Rba10gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgIFwic29scl9xdWVyeT0nJXMnXCIsXG4gICAgICAgICAgICBxdWVyeU9iamVjdFtrXS5yZXBsYWNlKC8nL2csIFwiJydcIiksXG4gICAgICAgICAgKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHNvbHJxdWVyeScpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCB3aGVyZU9iamVjdCA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIC8vIEFycmF5IG9mIG9wZXJhdG9yc1xuICAgIGlmICghKHdoZXJlT2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpKSB3aGVyZU9iamVjdCA9IFt3aGVyZU9iamVjdF07XG5cbiAgICBmb3IgKGxldCBmayA9IDA7IGZrIDwgd2hlcmVPYmplY3QubGVuZ3RoOyBmaysrKSB7XG4gICAgICBsZXQgZmllbGRSZWxhdGlvbiA9IHdoZXJlT2JqZWN0W2ZrXTtcblxuICAgICAgY29uc3QgY3FsT3BlcmF0b3JzID0ge1xuICAgICAgICAkZXE6ICc9JyxcbiAgICAgICAgJGd0OiAnPicsXG4gICAgICAgICRsdDogJzwnLFxuICAgICAgICAkZ3RlOiAnPj0nLFxuICAgICAgICAkbHRlOiAnPD0nLFxuICAgICAgICAkaW46ICdJTicsXG4gICAgICAgICRsaWtlOiAnTElLRScsXG4gICAgICAgICR0b2tlbjogJ3Rva2VuJyxcbiAgICAgICAgJGNvbnRhaW5zOiAnQ09OVEFJTlMnLFxuICAgICAgICAkY29udGFpbnNfa2V5OiAnQ09OVEFJTlMgS0VZJyxcbiAgICAgIH07XG5cbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRSZWxhdGlvbikpIHtcbiAgICAgICAgY29uc3QgdmFsaWRLZXlzID0gT2JqZWN0LmtleXMoY3FsT3BlcmF0b3JzKTtcbiAgICAgICAgY29uc3QgZmllbGRSZWxhdGlvbktleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWVsZFJlbGF0aW9uS2V5cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmICh2YWxpZEtleXMuaW5kZXhPZihmaWVsZFJlbGF0aW9uS2V5c1tpXSkgPCAwKSB7IC8vIGZpZWxkIHJlbGF0aW9uIGtleSBpbnZhbGlkXG4gICAgICAgICAgICBmaWVsZFJlbGF0aW9uID0geyAkZXE6IGZpZWxkUmVsYXRpb24gfTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZmllbGRSZWxhdGlvbiA9IHsgJGVxOiBmaWVsZFJlbGF0aW9uIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlbEtleXMgPSBPYmplY3Qua2V5cyhmaWVsZFJlbGF0aW9uKTtcbiAgICAgIGZvciAobGV0IHJrID0gMDsgcmsgPCByZWxLZXlzLmxlbmd0aDsgcmsrKykge1xuICAgICAgICBsZXQgZmlyc3RLZXkgPSByZWxLZXlzW3JrXTtcbiAgICAgICAgY29uc3QgZmlyc3RWYWx1ZSA9IGZpZWxkUmVsYXRpb25bZmlyc3RLZXldO1xuICAgICAgICBpZiAoZmlyc3RLZXkudG9Mb3dlckNhc2UoKSBpbiBjcWxPcGVyYXRvcnMpIHtcbiAgICAgICAgICBmaXJzdEtleSA9IGZpcnN0S2V5LnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgbGV0IG9wID0gY3FsT3BlcmF0b3JzW2ZpcnN0S2V5XTtcblxuICAgICAgICAgIGlmIChmaXJzdEtleSA9PT0gJyRpbicgJiYgIShmaXJzdFZhbHVlIGluc3RhbmNlb2YgQXJyYXkpKSB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkaW5vcCcpKTtcbiAgICAgICAgICBpZiAoZmlyc3RLZXkgPT09ICckdG9rZW4nICYmICEoZmlyc3RWYWx1ZSBpbnN0YW5jZW9mIE9iamVjdCkpIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWR0b2tlbicpKTtcblxuICAgICAgICAgIGxldCB3aGVyZVRlbXBsYXRlID0gJ1wiJXNcIiAlcyAlcyc7XG4gICAgICAgICAgaWYgKGZpcnN0S2V5ID09PSAnJHRva2VuJykge1xuICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSA9ICd0b2tlbihcIiVzXCIpICVzIHRva2VuKCVzKSc7XG5cbiAgICAgICAgICAgIGNvbnN0IHRva2VuUmVsS2V5cyA9IE9iamVjdC5rZXlzKGZpcnN0VmFsdWUpO1xuICAgICAgICAgICAgZm9yIChsZXQgdG9rZW5SSyA9IDA7IHRva2VuUksgPCB0b2tlblJlbEtleXMubGVuZ3RoOyB0b2tlblJLKyspIHtcbiAgICAgICAgICAgICAgbGV0IHRva2VuRmlyc3RLZXkgPSB0b2tlblJlbEtleXNbdG9rZW5SS107XG4gICAgICAgICAgICAgIGNvbnN0IHRva2VuRmlyc3RWYWx1ZSA9IGZpcnN0VmFsdWVbdG9rZW5GaXJzdEtleV07XG4gICAgICAgICAgICAgIHRva2VuRmlyc3RLZXkgPSB0b2tlbkZpcnN0S2V5LnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgICAgIGlmICgodG9rZW5GaXJzdEtleSBpbiBjcWxPcGVyYXRvcnMpICYmIHRva2VuRmlyc3RLZXkgIT09ICckdG9rZW4nICYmIHRva2VuRmlyc3RLZXkgIT09ICckaW4nKSB7XG4gICAgICAgICAgICAgICAgb3AgPSBjcWxPcGVyYXRvcnNbdG9rZW5GaXJzdEtleV07XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZHRva2Vub3AnLCB0b2tlbkZpcnN0S2V5KSk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBpZiAodG9rZW5GaXJzdFZhbHVlIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0b2tlbktleXMgPSBrLnNwbGl0KCcsJyk7XG4gICAgICAgICAgICAgICAgZm9yIChsZXQgdG9rZW5JbmRleCA9IDA7IHRva2VuSW5kZXggPCB0b2tlbkZpcnN0VmFsdWUubGVuZ3RoOyB0b2tlbkluZGV4KyspIHtcbiAgICAgICAgICAgICAgICAgIHRva2VuS2V5c1t0b2tlbkluZGV4XSA9IHRva2VuS2V5c1t0b2tlbkluZGV4XS50cmltKCk7XG4gICAgICAgICAgICAgICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKHRva2VuS2V5c1t0b2tlbkluZGV4XSwgdG9rZW5GaXJzdFZhbHVlW3Rva2VuSW5kZXhdKTtcbiAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG9rZW5GaXJzdFZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWwucXVlcnlfc2VnbWVudDtcbiAgICAgICAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdG9rZW5GaXJzdFZhbHVlW3Rva2VuSW5kZXhdID0gZGJWYWw7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgICAgdG9rZW5LZXlzLmpvaW4oJ1wiLFwiJyksIG9wLCB0b2tlbkZpcnN0VmFsdWUudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBkYlZhbCA9IHRoaXMuX2dldF9kYl92YWx1ZV9leHByZXNzaW9uKGssIHRva2VuRmlyc3RWYWx1ZSk7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgaywgb3AsIGRiVmFsLnF1ZXJ5X3NlZ21lbnQsXG4gICAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgaywgb3AsIGRiVmFsLFxuICAgICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChmaXJzdEtleSA9PT0gJyRjb250YWlucycpIHtcbiAgICAgICAgICAgIGNvbnN0IGZpZWxkdHlwZTEgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hLCBrKTtcbiAgICAgICAgICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmRleE9mKGZpZWxkdHlwZTEpID49IDApIHtcbiAgICAgICAgICAgICAgaWYgKGZpZWxkdHlwZTEgPT09ICdtYXAnICYmIF8uaXNQbGFpbk9iamVjdChmaXJzdFZhbHVlKSAmJiBPYmplY3Qua2V5cyhmaXJzdFZhbHVlKS5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgJ1wiJXNcIlslc10gJXMgJXMnLFxuICAgICAgICAgICAgICAgICAgaywgJz8nLCAnPScsICc/JyxcbiAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKE9iamVjdC5rZXlzKGZpcnN0VmFsdWUpWzBdKTtcbiAgICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGZpcnN0VmFsdWVbT2JqZWN0LmtleXMoZmlyc3RWYWx1ZSlbMF1dKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVJlbGF0aW9ucy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICAgIGssIG9wLCAnPycsXG4gICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChmaXJzdFZhbHVlKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5zb3AnKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChmaXJzdEtleSA9PT0gJyRjb250YWluc19rZXknKSB7XG4gICAgICAgICAgICBjb25zdCBmaWVsZHR5cGUyID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZSh0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYSwgayk7XG4gICAgICAgICAgICBpZiAoWydtYXAnXS5pbmRleE9mKGZpZWxkdHlwZTIpID49IDApIHtcbiAgICAgICAgICAgICAgcXVlcnlSZWxhdGlvbnMucHVzaCh1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgICB3aGVyZVRlbXBsYXRlLFxuICAgICAgICAgICAgICAgIGssIG9wLCAnPycsXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGZpcnN0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZGNvbnRhaW5za2V5b3AnKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IGRiVmFsID0gdGhpcy5fZ2V0X2RiX3ZhbHVlX2V4cHJlc3Npb24oaywgZmlyc3RWYWx1ZSk7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICBrLCBvcCwgZGJWYWwucXVlcnlfc2VnbWVudCxcbiAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHF1ZXJ5UmVsYXRpb25zLnB1c2godXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICAgd2hlcmVUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgICBrLCBvcCwgZGJWYWwsXG4gICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5pbnZhbGlkb3AnLCBmaXJzdEtleSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHF1ZXJ5OiAocXVlcnlSZWxhdGlvbnMubGVuZ3RoID4gMCA/IHV0aWwuZm9ybWF0KCdXSEVSRSAlcycsIHF1ZXJ5UmVsYXRpb25zLmpvaW4oJyBBTkQgJykpIDogJycpLFxuICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gIH07XG59O1xuXG5CYXNlTW9kZWwuX2NyZWF0ZV9maW5kX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucykge1xuICBjb25zdCBvcmRlcktleXMgPSBbXTtcbiAgbGV0IGxpbWl0ID0gbnVsbDtcblxuICBPYmplY3Qua2V5cyhxdWVyeU9iamVjdCkuZm9yRWFjaCgoaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5SXRlbSA9IHF1ZXJ5T2JqZWN0W2tdO1xuICAgIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckb3JkZXJieScpIHtcbiAgICAgIGlmICghKHF1ZXJ5SXRlbSBpbnN0YW5jZW9mIE9iamVjdCkpIHtcbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuaW52YWxpZG9yZGVyJykpO1xuICAgICAgfVxuICAgICAgY29uc3Qgb3JkZXJJdGVtS2V5cyA9IE9iamVjdC5rZXlzKHF1ZXJ5SXRlbSk7XG4gICAgICBpZiAob3JkZXJJdGVtS2V5cy5sZW5ndGggPiAxKSB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5tdWx0aW9yZGVyJykpO1xuXG4gICAgICBjb25zdCBjcWxPcmRlckRpcmVjdGlvbiA9IHsgJGFzYzogJ0FTQycsICRkZXNjOiAnREVTQycgfTtcbiAgICAgIGlmIChvcmRlckl0ZW1LZXlzWzBdLnRvTG93ZXJDYXNlKCkgaW4gY3FsT3JkZXJEaXJlY3Rpb24pIHtcbiAgICAgICAgbGV0IG9yZGVyRmllbGRzID0gcXVlcnlJdGVtW29yZGVySXRlbUtleXNbMF1dO1xuXG4gICAgICAgIGlmICghKG9yZGVyRmllbGRzIGluc3RhbmNlb2YgQXJyYXkpKSBvcmRlckZpZWxkcyA9IFtvcmRlckZpZWxkc107XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcmRlckZpZWxkcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIG9yZGVyS2V5cy5wdXNoKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgJ1wiJXNcIiAlcycsXG4gICAgICAgICAgICBvcmRlckZpZWxkc1tpXSwgY3FsT3JkZXJEaXJlY3Rpb25bb3JkZXJJdGVtS2V5c1swXV0sXG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmludmFsaWRvcmRlcnR5cGUnLCBvcmRlckl0ZW1LZXlzWzBdKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChrLnRvTG93ZXJDYXNlKCkgPT09ICckbGltaXQnKSB7XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5SXRlbSAhPT0gJ251bWJlcicpIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmxpbWl0dHlwZScpKTtcbiAgICAgIGxpbWl0ID0gcXVlcnlJdGVtO1xuICAgIH1cbiAgfSk7XG5cbiAgY29uc3Qgd2hlcmVDbGF1c2UgPSB0aGlzLl9jcmVhdGVfd2hlcmVfY2xhdXNlKHF1ZXJ5T2JqZWN0KTtcblxuICBsZXQgc2VsZWN0ID0gJyonO1xuICBpZiAob3B0aW9ucy5zZWxlY3QgJiYgXy5pc0FycmF5KG9wdGlvbnMuc2VsZWN0KSAmJiBvcHRpb25zLnNlbGVjdC5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc2VsZWN0QXJyYXkgPSBbXTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG9wdGlvbnMuc2VsZWN0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICAvLyBzZXBhcmF0ZSB0aGUgYWdncmVnYXRlIGZ1bmN0aW9uIGFuZCB0aGUgY29sdW1uIG5hbWUgaWYgc2VsZWN0IGlzIGFuIGFnZ3JlZ2F0ZSBmdW5jdGlvblxuICAgICAgY29uc3Qgc2VsZWN0aW9uID0gb3B0aW9ucy5zZWxlY3RbaV0uc3BsaXQoL1soICldL2cpLmZpbHRlcigoZSkgPT4gKGUpKTtcbiAgICAgIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIHNlbGVjdEFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIicsIHNlbGVjdGlvblswXSkpO1xuICAgICAgfSBlbHNlIGlmIChzZWxlY3Rpb24ubGVuZ3RoID09PSAyIHx8IHNlbGVjdGlvbi5sZW5ndGggPT09IDQpIHtcbiAgICAgICAgbGV0IGZ1bmN0aW9uQ2xhdXNlID0gdXRpbC5mb3JtYXQoJyVzKFwiJXNcIiknLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSk7XG4gICAgICAgIGlmIChzZWxlY3Rpb25bMl0pIGZ1bmN0aW9uQ2xhdXNlICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBzZWxlY3Rpb25bMl0pO1xuICAgICAgICBpZiAoc2VsZWN0aW9uWzNdKSBmdW5jdGlvbkNsYXVzZSArPSB1dGlsLmZvcm1hdCgnICVzJywgc2VsZWN0aW9uWzNdKTtcblxuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKGZ1bmN0aW9uQ2xhdXNlKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VsZWN0aW9uLmxlbmd0aCA9PT0gMykge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCIgJXMgJXMnLCBzZWxlY3Rpb25bMF0sIHNlbGVjdGlvblsxXSwgc2VsZWN0aW9uWzJdKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWxlY3RBcnJheS5wdXNoKCcqJyk7XG4gICAgICB9XG4gICAgfVxuICAgIHNlbGVjdCA9IHNlbGVjdEFycmF5LmpvaW4oJywnKTtcbiAgfVxuXG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdTRUxFQ1QgJXMgJXMgRlJPTSBcIiVzXCIgJXMgJXMgJXMnLFxuICAgIChvcHRpb25zLmRpc3RpbmN0ID8gJ0RJU1RJTkNUJyA6ICcnKSxcbiAgICBzZWxlY3QsXG4gICAgb3B0aW9ucy5tYXRlcmlhbGl6ZWRfdmlldyA/IG9wdGlvbnMubWF0ZXJpYWxpemVkX3ZpZXcgOiB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsXG4gICAgd2hlcmVDbGF1c2UucXVlcnksXG4gICAgb3JkZXJLZXlzLmxlbmd0aCA/IHV0aWwuZm9ybWF0KCdPUkRFUiBCWSAlcycsIG9yZGVyS2V5cy5qb2luKCcsICcpKSA6ICcgJyxcbiAgICBsaW1pdCA/IHV0aWwuZm9ybWF0KCdMSU1JVCAlcycsIGxpbWl0KSA6ICcgJyxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5hbGxvd19maWx0ZXJpbmcpIHF1ZXJ5ICs9ICcgQUxMT1cgRklMVEVSSU5HOyc7XG4gIGVsc2UgcXVlcnkgKz0gJzsnO1xuXG4gIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHdoZXJlQ2xhdXNlLnBhcmFtcyB9O1xufTtcblxuQmFzZU1vZGVsLmdldF90YWJsZV9uYW1lID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZTtcbn07XG5cbkJhc2VNb2RlbC5pc190YWJsZV9yZWFkeSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLl9yZWFkeSA9PT0gdHJ1ZTtcbn07XG5cbkJhc2VNb2RlbC5pbml0ID0gZnVuY3Rpb24gZihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoIWNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB1bmRlZmluZWQ7XG4gIH1cblxuICB0aGlzLl9yZWFkeSA9IHRydWU7XG4gIGNhbGxiYWNrKCk7XG59O1xuXG5CYXNlTW9kZWwuc3luY0RlZmluaXRpb24gPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IGFmdGVyQ3JlYXRlID0gKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIHtcbiAgICAgIHRoaXMuX3JlYWR5ID0gdHJ1ZTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgfVxuICB9O1xuXG4gIHRoaXMuX2NyZWF0ZV90YWJsZShhZnRlckNyZWF0ZSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9xdWVyeSA9IGZ1bmN0aW9uIGYocXVlcnksIHBhcmFtcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgcXVlcnk6ICVzIHdpdGggcGFyYW1zOiAlaicsIHF1ZXJ5LCBwYXJhbXMpO1xuICAgIHRoaXMuX3Byb3BlcnRpZXMuY3FsLmV4ZWN1dGUocXVlcnksIHBhcmFtcywgb3B0aW9ucywgKGVycjEsIHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKGVycjEgJiYgZXJyMS5jb2RlID09PSA4NzA0KSB7XG4gICAgICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgcGFyYW1zLCBjYWxsYmFjayk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsYmFjayhlcnIxLCByZXN1bHQpO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX2VhY2hSb3cgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgZWFjaFJvdyBxdWVyeTogJXMgd2l0aCBwYXJhbXM6ICVqJywgcXVlcnksIHBhcmFtcyk7XG4gICAgdGhpcy5fcHJvcGVydGllcy5jcWwuZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX2VhY2hSb3cgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICB0aGlzLmV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5leGVjdXRlX2VhY2hSb3cocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spO1xuICAgIH0pO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY29uc3QgY2IgPSBvblJlYWRhYmxlO1xuICAgIG9uUmVhZGFibGUgPSBvcHRpb25zO1xuICAgIGNhbGxiYWNrID0gY2I7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2Ygb25SZWFkYWJsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmVhY2hyb3dlcnJvcicsICdubyB2YWxpZCBvblJlYWRhYmxlIGZ1bmN0aW9uIHdhcyBwcm92aWRlZCcpKTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIG9wdGlvbnMucmV0dXJuX3F1ZXJ5ID0gdHJ1ZTtcbiAgY29uc3Qgc2VsZWN0UXVlcnkgPSB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgcHJlcGFyZTogb3B0aW9ucy5wcmVwYXJlIH07XG4gIGlmIChvcHRpb25zLmNvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuY29uc2lzdGVuY3kgPSBvcHRpb25zLmNvbnNpc3RlbmN5O1xuICBpZiAob3B0aW9ucy5mZXRjaFNpemUpIHF1ZXJ5T3B0aW9ucy5mZXRjaFNpemUgPSBvcHRpb25zLmZldGNoU2l6ZTtcbiAgaWYgKG9wdGlvbnMuYXV0b1BhZ2UpIHF1ZXJ5T3B0aW9ucy5hdXRvUGFnZSA9IG9wdGlvbnMuYXV0b1BhZ2U7XG4gIGlmIChvcHRpb25zLmhpbnRzKSBxdWVyeU9wdGlvbnMuaGludHMgPSBvcHRpb25zLmhpbnRzO1xuICBpZiAob3B0aW9ucy5wYWdlU3RhdGUpIHF1ZXJ5T3B0aW9ucy5wYWdlU3RhdGUgPSBvcHRpb25zLnBhZ2VTdGF0ZTtcbiAgaWYgKG9wdGlvbnMucmV0cnkpIHF1ZXJ5T3B0aW9ucy5yZXRyeSA9IG9wdGlvbnMucmV0cnk7XG4gIGlmIChvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kgPSBvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5O1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfZWFjaFJvdyhzZWxlY3RRdWVyeS5xdWVyeSwgc2VsZWN0UXVlcnkucGFyYW1zLCBxdWVyeU9wdGlvbnMsIChuLCByb3cpID0+IHtcbiAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gdGhpcy5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgIHJvdyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICByb3cuX21vZGlmaWVkID0ge307XG4gICAgfVxuICAgIG9uUmVhZGFibGUobiwgcm93KTtcbiAgfSwgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0KTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2Vuc3VyZV9jb25uZWN0ZWQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGRlYnVnKCdleGVjdXRpbmcgc3RyZWFtIHF1ZXJ5OiAlcyB3aXRoIHBhcmFtczogJWonLCBxdWVyeSwgcGFyYW1zKTtcbiAgICB0aGlzLl9wcm9wZXJ0aWVzLmNxbC5zdHJlYW0ocXVlcnksIHBhcmFtcywgb3B0aW9ucykub24oJ3JlYWRhYmxlJywgb25SZWFkYWJsZSkub24oJ2VuZCcsIGNhbGxiYWNrKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfdGFibGVfc3RyZWFtID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICBpZiAodGhpcy5pc190YWJsZV9yZWFkeSgpKSB7XG4gICAgdGhpcy5leGVjdXRlX3N0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5leGVjdXRlX3N0cmVhbShxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgIGNvbnN0IGNiID0gb25SZWFkYWJsZTtcbiAgICBvblJlYWRhYmxlID0gb3B0aW9ucztcbiAgICBjYWxsYmFjayA9IGNiO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb25SZWFkYWJsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLnN0cmVhbWVycm9yJywgJ25vIHZhbGlkIG9uUmVhZGFibGUgZnVuY3Rpb24gd2FzIHByb3ZpZGVkJykpO1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcmF3OiBmYWxzZSxcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgb3B0aW9ucy5yZXR1cm5fcXVlcnkgPSB0cnVlO1xuICBjb25zdCBzZWxlY3RRdWVyeSA9IHRoaXMuZmluZChxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9zdHJlYW0oc2VsZWN0UXVlcnkucXVlcnksIHNlbGVjdFF1ZXJ5LnBhcmFtcywgcXVlcnlPcHRpb25zLCBmdW5jdGlvbiBmMSgpIHtcbiAgICBjb25zdCByZWFkZXIgPSB0aGlzO1xuICAgIHJlYWRlci5yZWFkUm93ID0gKCkgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmICghcm93KSByZXR1cm4gcm93O1xuICAgICAgaWYgKCFvcHRpb25zLnJhdykge1xuICAgICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gc2VsZi5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIG9uUmVhZGFibGUocmVhZGVyKTtcbiAgfSwgKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZGJlcnJvcicsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjaygpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5maW5kID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicgJiYgIW9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIC8vIHNldCByYXcgdHJ1ZSBpZiBzZWxlY3QgaXMgdXNlZCxcbiAgLy8gYmVjYXVzZSBjYXN0aW5nIHRvIG1vZGVsIGluc3RhbmNlcyBtYXkgbGVhZCB0byBwcm9ibGVtc1xuICBpZiAob3B0aW9ucy5zZWxlY3QpIG9wdGlvbnMucmF3ID0gdHJ1ZTtcblxuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBsZXQgcXVlcnk7XG4gIHRyeSB7XG4gICAgY29uc3QgZmluZFF1ZXJ5ID0gdGhpcy5fY3JlYXRlX2ZpbmRfcXVlcnkocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuICAgIHF1ZXJ5ID0gZmluZFF1ZXJ5LnF1ZXJ5O1xuICAgIHF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXMuY29uY2F0KGZpbmRRdWVyeS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2soZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIHRocm93IChlKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHF1ZXJ5UGFyYW1zIH07XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSB7IHByZXBhcmU6IG9wdGlvbnMucHJlcGFyZSB9O1xuICBpZiAob3B0aW9ucy5jb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLmNvbnNpc3RlbmN5ID0gb3B0aW9ucy5jb25zaXN0ZW5jeTtcbiAgaWYgKG9wdGlvbnMuZmV0Y2hTaXplKSBxdWVyeU9wdGlvbnMuZmV0Y2hTaXplID0gb3B0aW9ucy5mZXRjaFNpemU7XG4gIGlmIChvcHRpb25zLmF1dG9QYWdlKSBxdWVyeU9wdGlvbnMuYXV0b1BhZ2UgPSBvcHRpb25zLmF1dG9QYWdlO1xuICBpZiAob3B0aW9ucy5oaW50cykgcXVlcnlPcHRpb25zLmhpbnRzID0gb3B0aW9ucy5oaW50cztcbiAgaWYgKG9wdGlvbnMucGFnZVN0YXRlKSBxdWVyeU9wdGlvbnMucGFnZVN0YXRlID0gb3B0aW9ucy5wYWdlU3RhdGU7XG4gIGlmIChvcHRpb25zLnJldHJ5KSBxdWVyeU9wdGlvbnMucmV0cnkgPSBvcHRpb25zLnJldHJ5O1xuICBpZiAob3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSkgcXVlcnlPcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5ID0gb3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeTtcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZmluZC5kYmVycm9yJywgZXJyKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghb3B0aW9ucy5yYXcpIHtcbiAgICAgIGNvbnN0IE1vZGVsQ29uc3RydWN0b3IgPSB0aGlzLl9wcm9wZXJ0aWVzLmdldF9jb25zdHJ1Y3RvcigpO1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJlcyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfSk7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0cyA9IHJlc3VsdHMucm93cy5tYXAoKHJlcykgPT4ge1xuICAgICAgICBkZWxldGUgKHJlcy5jb2x1bW5zKTtcbiAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgIH0pO1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwuZmluZE9uZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nICYmICFvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmNiZXJyb3InKSk7XG4gIH1cblxuICBxdWVyeU9iamVjdC4kbGltaXQgPSAxO1xuXG4gIHJldHVybiB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzWzBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2soKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwudXBkYXRlID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMyAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgY29uc3QgdXBkYXRlQ2xhdXNlQXJyYXkgPSBbXTtcblxuICBsZXQgZXJyb3JIYXBwZW5lZCA9IE9iamVjdC5rZXlzKHVwZGF0ZVZhbHVlcykuc29tZSgoa2V5KSA9PiB7XG4gICAgaWYgKHNjaGVtYS5maWVsZHNba2V5XSA9PT0gdW5kZWZpbmVkIHx8IHNjaGVtYS5maWVsZHNba2V5XS52aXJ0dWFsKSByZXR1cm4gZmFsc2U7XG5cbiAgICAvLyBjaGVjayBmaWVsZCB2YWx1ZVxuICAgIGNvbnN0IGZpZWxkdHlwZSA9IHNjaGVtZXIuZ2V0X2ZpZWxkX3R5cGUoc2NoZW1hLCBrZXkpO1xuICAgIGxldCBmaWVsZHZhbHVlID0gdXBkYXRlVmFsdWVzW2tleV07XG5cbiAgICBpZiAoZmllbGR2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmaWVsZHZhbHVlID0gdGhpcy5fZ2V0X2RlZmF1bHRfdmFsdWUoa2V5KTtcbiAgICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihrZXkpID49IDAgfHwgc2NoZW1hLmtleVswXS5pbmRleE9mKGtleSkgPj0gMCkge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldGtleScsIGtleSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRrZXknLCBrZXkpKTtcbiAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2tleV0ucnVsZSAmJiBzY2hlbWEuZmllbGRzW2tleV0ucnVsZS5yZXF1aXJlZCkge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldHJlcXVpcmVkJywga2V5KSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS51bnNldHJlcXVpcmVkJywga2V5KSk7XG4gICAgICAgIH0gZWxzZSByZXR1cm4gZmFsc2U7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2tleV0ucnVsZSB8fCAhc2NoZW1hLmZpZWxkc1trZXldLnJ1bGUuaWdub3JlX2RlZmF1bHQpIHtcbiAgICAgICAgLy8gZGlkIHNldCBhIGRlZmF1bHQgdmFsdWUsIGlnbm9yZSBkZWZhdWx0IGlzIG5vdCBzZXRcbiAgICAgICAgaWYgKHRoaXMudmFsaWRhdGUoa2V5LCBmaWVsZHZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkZGVmYXVsdHZhbHVlJywgZmllbGR2YWx1ZSwga2V5LCBmaWVsZHR5cGUpKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZHZhbHVlLCBrZXksIGZpZWxkdHlwZSkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkdmFsdWUgPT09IG51bGwgfHwgZmllbGR2YWx1ZSA9PT0gY3FsLnR5cGVzLnVuc2V0KSB7XG4gICAgICBpZiAoc2NoZW1hLmtleS5pbmRleE9mKGtleSkgPj0gMCB8fCBzY2hlbWEua2V5WzBdLmluZGV4T2Yoa2V5KSA+PSAwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRrZXknLCBrZXkpKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLnVuc2V0a2V5Jywga2V5KSk7XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNba2V5XS5ydWxlICYmIHNjaGVtYS5maWVsZHNba2V5XS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRyZXF1aXJlZCcsIGtleSkpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUudW5zZXRyZXF1aXJlZCcsIGtleSkpO1xuICAgICAgfVxuICAgIH1cblxuXG4gICAgdHJ5IHtcbiAgICAgIGxldCAkYWRkID0gZmFsc2U7XG4gICAgICBsZXQgJGFwcGVuZCA9IGZhbHNlO1xuICAgICAgbGV0ICRwcmVwZW5kID0gZmFsc2U7XG4gICAgICBsZXQgJHJlcGxhY2UgPSBmYWxzZTtcbiAgICAgIGxldCAkcmVtb3ZlID0gZmFsc2U7XG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGZpZWxkdmFsdWUpKSB7XG4gICAgICAgIGlmIChmaWVsZHZhbHVlLiRhZGQpIHtcbiAgICAgICAgICBmaWVsZHZhbHVlID0gZmllbGR2YWx1ZS4kYWRkO1xuICAgICAgICAgICRhZGQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkdmFsdWUuJGFwcGVuZCkge1xuICAgICAgICAgIGZpZWxkdmFsdWUgPSBmaWVsZHZhbHVlLiRhcHBlbmQ7XG4gICAgICAgICAgJGFwcGVuZCA9IHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGR2YWx1ZS4kcHJlcGVuZCkge1xuICAgICAgICAgIGZpZWxkdmFsdWUgPSBmaWVsZHZhbHVlLiRwcmVwZW5kO1xuICAgICAgICAgICRwcmVwZW5kID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZHZhbHVlLiRyZXBsYWNlKSB7XG4gICAgICAgICAgZmllbGR2YWx1ZSA9IGZpZWxkdmFsdWUuJHJlcGxhY2U7XG4gICAgICAgICAgJHJlcGxhY2UgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkdmFsdWUuJHJlbW92ZSkge1xuICAgICAgICAgIGZpZWxkdmFsdWUgPSBmaWVsZHZhbHVlLiRyZW1vdmU7XG4gICAgICAgICAgJHJlbW92ZSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihrZXksIGZpZWxkdmFsdWUpO1xuXG4gICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGRiVmFsKSAmJiBkYlZhbC5xdWVyeV9zZWdtZW50KSB7XG4gICAgICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCddLmluZGV4T2YoZmllbGR0eXBlKSA+IC0xKSB7XG4gICAgICAgICAgaWYgKCRhZGQgfHwgJGFwcGVuZCkge1xuICAgICAgICAgICAgZGJWYWwucXVlcnlfc2VnbWVudCA9IHV0aWwuZm9ybWF0KCdcIiVzXCIgKyAlcycsIGtleSwgZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgICAgfSBlbHNlIGlmICgkcHJlcGVuZCkge1xuICAgICAgICAgICAgaWYgKGZpZWxkdHlwZSA9PT0gJ2xpc3QnKSB7XG4gICAgICAgICAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSB1dGlsLmZvcm1hdCgnJXMgKyBcIiVzXCInLCBkYlZhbC5xdWVyeV9zZWdtZW50LCBrZXkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgICAgICAgJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcHJlcGVuZG9wJyxcbiAgICAgICAgICAgICAgICB1dGlsLmZvcm1hdCgnJXMgZGF0YXR5cGVzIGRvZXMgbm90IHN1cHBvcnQgJHByZXBlbmQsIHVzZSAkYWRkIGluc3RlYWQnLCBmaWVsZHR5cGUpLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2UgaWYgKCRyZW1vdmUpIHtcbiAgICAgICAgICAgIGRiVmFsLnF1ZXJ5X3NlZ21lbnQgPSB1dGlsLmZvcm1hdCgnXCIlc1wiIC0gJXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpO1xuICAgICAgICAgICAgaWYgKGZpZWxkdHlwZSA9PT0gJ21hcCcpIGRiVmFsLnBhcmFtZXRlciA9IE9iamVjdC5rZXlzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRyZXBsYWNlKSB7XG4gICAgICAgICAgaWYgKGZpZWxkdHlwZSA9PT0gJ21hcCcpIHtcbiAgICAgICAgICAgIHVwZGF0ZUNsYXVzZUFycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIls/XT0lcycsIGtleSwgZGJWYWwucXVlcnlfc2VnbWVudCkpO1xuICAgICAgICAgICAgY29uc3QgcmVwbGFjZUtleXMgPSBPYmplY3Qua2V5cyhkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICAgICAgY29uc3QgcmVwbGFjZVZhbHVlcyA9IF8udmFsdWVzKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgICAgICBpZiAocmVwbGFjZUtleXMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2gocmVwbGFjZUtleXNbMF0pO1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKHJlcGxhY2VWYWx1ZXNbMF0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgKFxuICAgICAgICAgICAgICAgIGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5pbnZhbGlkcmVwbGFjZW9wJywgJyRyZXBsYWNlIGluIG1hcCBkb2VzIG5vdCBzdXBwb3J0IG1vcmUgdGhhbiBvbmUgaXRlbScpXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChmaWVsZHR5cGUgPT09ICdsaXN0Jykge1xuICAgICAgICAgICAgdXBkYXRlQ2xhdXNlQXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiWz9dPSVzJywga2V5LCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICAgICAgICBpZiAoZGJWYWwucGFyYW1ldGVyLmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlclswXSk7XG4gICAgICAgICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyWzFdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKFxuICAgICAgICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgICAgICAgICAgJyRyZXBsYWNlIGluIGxpc3Qgc2hvdWxkIGhhdmUgZXhhY3RseSAyIGl0ZW1zLCBmaXJzdCBvbmUgYXMgdGhlIGluZGV4IGFuZCB0aGUgc2Vjb25kIG9uZSBhcyB0aGUgdmFsdWUnLFxuICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoXG4gICAgICAgICAgICAgICdtb2RlbC51cGRhdGUuaW52YWxpZHJlcGxhY2VvcCcsXG4gICAgICAgICAgICAgIHV0aWwuZm9ybWF0KCclcyBkYXRhdHlwZXMgZG9lcyBub3Qgc3VwcG9ydCAkcmVwbGFjZScsIGZpZWxkdHlwZSksXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdXBkYXRlQ2xhdXNlQXJyYXkucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiPSVzJywga2V5LCBkYlZhbC5xdWVyeV9zZWdtZW50KSk7XG4gICAgICAgICAgcXVlcnlQYXJhbXMucHVzaChkYlZhbC5wYXJhbWV0ZXIpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB1cGRhdGVDbGF1c2VBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCI9JXMnLCBrZXksIGRiVmFsKSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBjYWxsYmFjayhlKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICB0aHJvdyAoZSk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSk7XG5cbiAgaWYgKGVycm9ySGFwcGVuZWQpIHJldHVybiB7fTtcblxuICBsZXQgcXVlcnkgPSAnVVBEQVRFIFwiJXNcIic7XG4gIGxldCB3aGVyZSA9ICcnO1xuICBpZiAob3B0aW9ucy50dGwpIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgVVNJTkcgVFRMICVzJywgb3B0aW9ucy50dGwpO1xuICBxdWVyeSArPSAnIFNFVCAlcyAlcyc7XG4gIHRyeSB7XG4gICAgY29uc3Qgd2hlcmVDbGF1c2UgPSB0aGlzLl9jcmVhdGVfd2hlcmVfY2xhdXNlKHF1ZXJ5T2JqZWN0KTtcbiAgICB3aGVyZSA9IHdoZXJlQ2xhdXNlLnF1ZXJ5O1xuICAgIHF1ZXJ5UGFyYW1zID0gcXVlcnlQYXJhbXMuY29uY2F0KHdoZXJlQ2xhdXNlLnBhcmFtcyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayhlKTtcbiAgICAgIHJldHVybiB7fTtcbiAgICB9XG4gICAgdGhyb3cgKGUpO1xuICB9XG4gIHF1ZXJ5ID0gdXRpbC5mb3JtYXQocXVlcnksIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSwgdXBkYXRlQ2xhdXNlQXJyYXkuam9pbignLCAnKSwgd2hlcmUpO1xuXG4gIGlmIChvcHRpb25zLmNvbmRpdGlvbnMpIHtcbiAgICBjb25zdCB1cGRhdGVDb25kaXRpb25zQXJyYXkgPSBbXTtcblxuICAgIGVycm9ySGFwcGVuZWQgPSBPYmplY3Qua2V5cyhvcHRpb25zLmNvbmRpdGlvbnMpLnNvbWUoKGtleSkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihrZXksIG9wdGlvbnMuY29uZGl0aW9uc1trZXldKTtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChkYlZhbCkgJiYgZGJWYWwucXVlcnlfc2VnbWVudCkge1xuICAgICAgICAgIHVwZGF0ZUNvbmRpdGlvbnNBcnJheS5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCI9JXMnLCBrZXksIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpKTtcbiAgICAgICAgICBxdWVyeVBhcmFtcy5wdXNoKGRiVmFsLnBhcmFtZXRlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdXBkYXRlQ29uZGl0aW9uc0FycmF5LnB1c2godXRpbC5mb3JtYXQoJ1wiJXNcIj0lcycsIGtleSwgZGJWYWwpKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH0pO1xuXG4gICAgaWYgKGVycm9ySGFwcGVuZWQpIHJldHVybiB7fTtcblxuICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgSUYgJXMnLCB1cGRhdGVDb25kaXRpb25zQXJyYXkuam9pbignIEFORCAnKSk7XG4gIH1cbiAgaWYgKG9wdGlvbnMuaWZfZXhpc3RzKSBxdWVyeSArPSAnIElGIEVYSVNUUyc7XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIC8vIHNldCBkdW1teSBob29rIGZ1bmN0aW9uIGlmIG5vdCBwcmVzZW50IGluIHNjaGVtYVxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfdXBkYXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmJlZm9yZV91cGRhdGUgPSBmdW5jdGlvbiBmMShxdWVyeU9iaiwgdXBkYXRlVmFsLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5hZnRlcl91cGRhdGUgPSBmdW5jdGlvbiBmMShxdWVyeU9iaiwgdXBkYXRlVmFsLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhvb2tSdW5uZXIoZm4sIGVycm9yQ29kZSkge1xuICAgIHJldHVybiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICBmbihxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgaG9va0NhbGxiYWNrKGJ1aWxkRXJyb3IoZXJyb3JDb2RlLCBlcnJvcikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBob29rQ2FsbGJhY2soKTtcbiAgICAgIH0pO1xuICAgIH07XG4gIH1cblxuICBpZiAob3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcXVlcnksXG4gICAgICBwYXJhbXM6IHF1ZXJ5UGFyYW1zLFxuICAgICAgYmVmb3JlX2hvb2s6IGhvb2tSdW5uZXIoc2NoZW1hLmJlZm9yZV91cGRhdGUsICdtb2RlbC51cGRhdGUuYmVmb3JlLmVycm9yJyksXG4gICAgICBhZnRlcl9ob29rOiBob29rUnVubmVyKHNjaGVtYS5hZnRlcl91cGRhdGUsICdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgc2NoZW1hLmJlZm9yZV91cGRhdGUocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgaWYgKGVycm9yKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5iZWZvcmUuZXJyb3InLCBlcnJvcikpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgfVxuXG4gICAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZW1hLmFmdGVyX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmFmdGVyLmVycm9yJywgZXJyb3IxKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2NoZW1hLmFmdGVyX3VwZGF0ZShxdWVyeU9iamVjdCwgdXBkYXRlVmFsdWVzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5hZnRlci5lcnJvcicsIGVycm9yMSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC5kZWxldGUgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMiAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBzY2hlbWEgPSB0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgbGV0IHF1ZXJ5ID0gJ0RFTEVURSBGUk9NIFwiJXNcIiAlczsnO1xuICBsZXQgd2hlcmUgPSAnJztcbiAgdHJ5IHtcbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHRoaXMuX2NyZWF0ZV93aGVyZV9jbGF1c2UocXVlcnlPYmplY3QpO1xuICAgIHdoZXJlID0gd2hlcmVDbGF1c2UucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQod2hlcmVDbGF1c2UucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cbiAgICB0aHJvdyAoZSk7XG4gIH1cblxuICBxdWVyeSA9IHV0aWwuZm9ybWF0KHF1ZXJ5LCB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsIHdoZXJlKTtcblxuICAvLyBzZXQgZHVtbXkgaG9vayBmdW5jdGlvbiBpZiBub3QgcHJlc2VudCBpbiBzY2hlbWFcbiAgaWYgKHR5cGVvZiBzY2hlbWEuYmVmb3JlX2RlbGV0ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5iZWZvcmVfZGVsZXRlID0gZnVuY3Rpb24gZjEocXVlcnlPYmosIG9wdGlvbnNPYmosIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgc2NoZW1hLmFmdGVyX2RlbGV0ZSA9IGZ1bmN0aW9uIGYxKHF1ZXJ5T2JqLCBvcHRpb25zT2JqLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gICAgICBiZWZvcmVfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYmVmb3JlX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICBhZnRlcl9ob29rOiAoaG9va0NhbGxiYWNrKSA9PiB7XG4gICAgICAgIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgaG9va0NhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGhvb2tDYWxsYmFjaygpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgcHJlcGFyZTogb3B0aW9ucy5wcmVwYXJlIH07XG4gIGlmIChvcHRpb25zLmNvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuY29uc2lzdGVuY3kgPSBvcHRpb25zLmNvbnNpc3RlbmN5O1xuICBpZiAob3B0aW9ucy5mZXRjaFNpemUpIHF1ZXJ5T3B0aW9ucy5mZXRjaFNpemUgPSBvcHRpb25zLmZldGNoU2l6ZTtcbiAgaWYgKG9wdGlvbnMuYXV0b1BhZ2UpIHF1ZXJ5T3B0aW9ucy5hdXRvUGFnZSA9IG9wdGlvbnMuYXV0b1BhZ2U7XG4gIGlmIChvcHRpb25zLmhpbnRzKSBxdWVyeU9wdGlvbnMuaGludHMgPSBvcHRpb25zLmhpbnRzO1xuICBpZiAob3B0aW9ucy5wYWdlU3RhdGUpIHF1ZXJ5T3B0aW9ucy5wYWdlU3RhdGUgPSBvcHRpb25zLnBhZ2VTdGF0ZTtcbiAgaWYgKG9wdGlvbnMucmV0cnkpIHF1ZXJ5T3B0aW9ucy5yZXRyeSA9IG9wdGlvbnMucmV0cnk7XG4gIGlmIChvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5KSBxdWVyeU9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kgPSBvcHRpb25zLnNlcmlhbENvbnNpc3RlbmN5O1xuXG4gIHNjaGVtYS5iZWZvcmVfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYmVmb3JlLmVycm9yJywgZXJyb3IpKTtcbiAgICB9XG5cbiAgICB0aGlzLl9leGVjdXRlX3RhYmxlX3F1ZXJ5KHF1ZXJ5LCBxdWVyeVBhcmFtcywgcXVlcnlPcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlbWEuYWZ0ZXJfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmFmdGVyLmVycm9yJywgZXJyb3IxKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuZGJlcnJvcicsIGVycikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2NoZW1hLmFmdGVyX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucywgKGVycm9yMSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcjEpIHtcbiAgICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwudHJ1bmNhdGUgPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG5cbiAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnVFJVTkNBVEUgVEFCTEUgXCIlc1wiOycsIHRhYmxlTmFtZSk7XG4gIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5kcm9wX212aWV3cyA9IGZ1bmN0aW9uIGYobXZpZXdzLCBjYWxsYmFjaykge1xuICBhc3luYy5lYWNoKG12aWV3cywgKHZpZXcsIHZpZXdDYWxsYmFjaykgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoJ0RST1AgTUFURVJJQUxJWkVEIFZJRVcgSUYgRVhJU1RTIFwiJXNcIjsnLCB2aWV3KTtcbiAgICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIFtdLCB2aWV3Q2FsbGJhY2spO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmRyb3BfaW5kZXhlcyA9IGZ1bmN0aW9uIGYoaW5kZXhlcywgY2FsbGJhY2spIHtcbiAgYXN5bmMuZWFjaChpbmRleGVzLCAoaW5kZXgsIGluZGV4Q2FsbGJhY2spID0+IHtcbiAgICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdEUk9QIElOREVYIElGIEVYSVNUUyBcIiVzXCI7JywgaW5kZXgpO1xuICAgIHRoaXMuX2V4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgW10sIGluZGV4Q2FsbGJhY2spO1xuICB9LCAoZXJyKSA9PiB7XG4gICAgaWYgKGVycikgY2FsbGJhY2soZXJyKTtcbiAgICBlbHNlIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmFsdGVyX3RhYmxlID0gZnVuY3Rpb24gZihvcGVyYXRpb24sIGZpZWxkbmFtZSwgdHlwZSwgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBpZiAob3BlcmF0aW9uID09PSAnQUxURVInKSB0eXBlID0gdXRpbC5mb3JtYXQoJ1RZUEUgJXMnLCB0eXBlKTtcbiAgZWxzZSBpZiAob3BlcmF0aW9uID09PSAnRFJPUCcpIHR5cGUgPSAnJztcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdBTFRFUiBUQUJMRSBcIiVzXCIgJXMgXCIlc1wiICVzOycsIHRhYmxlTmFtZSwgb3BlcmF0aW9uLCBmaWVsZG5hbWUsIHR5cGUpO1xuICB0aGlzLl9leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIFtdLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwuZHJvcF90YWJsZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdEUk9QIFRBQkxFIElGIEVYSVNUUyBcIiVzXCI7JywgdGFibGVOYW1lKTtcbiAgdGhpcy5fZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBbXSwgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5fZ2V0X2RhdGFfdHlwZXMgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gY3FsLnR5cGVzO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5fZ2V0X2RlZmF1bHRfdmFsdWUgPSBmdW5jdGlvbiBmKGZpZWxkbmFtZSkge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcztcbiAgY29uc3Qgc2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgaWYgKF8uaXNQbGFpbk9iamVjdChzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0pICYmIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdLmRlZmF1bHQuY2FsbCh0aGlzKTtcbiAgICB9XG4gICAgcmV0dXJuIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLnZhbGlkYXRlID0gZnVuY3Rpb24gZihwcm9wZXJ0eU5hbWUsIHZhbHVlKSB7XG4gIHZhbHVlID0gdmFsdWUgfHwgdGhpc1twcm9wZXJ0eU5hbWVdO1xuICB0aGlzLl92YWxpZGF0b3JzID0gdGhpcy5fdmFsaWRhdG9ycyB8fCB7fTtcbiAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuX3ZhbGlkYXRlKHRoaXMuX3ZhbGlkYXRvcnNbcHJvcGVydHlOYW1lXSB8fCBbXSwgdmFsdWUpO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5zYXZlID0gZnVuY3Rpb24gZm4ob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3QgaWRlbnRpZmllcnMgPSBbXTtcbiAgY29uc3QgdmFsdWVzID0gW107XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBzY2hlbWEgPSBwcm9wZXJ0aWVzLnNjaGVtYTtcblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgY29uc3QgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBjb25zdCBlcnJvckhhcHBlbmVkID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuc29tZSgoZikgPT4ge1xuICAgIGlmIChzY2hlbWEuZmllbGRzW2ZdLnZpcnR1YWwpIHJldHVybiBmYWxzZTtcblxuICAgIC8vIGNoZWNrIGZpZWxkIHZhbHVlXG4gICAgY29uc3QgZmllbGR0eXBlID0gc2NoZW1lci5nZXRfZmllbGRfdHlwZShzY2hlbWEsIGYpO1xuICAgIGxldCBmaWVsZHZhbHVlID0gdGhpc1tmXTtcblxuICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGZpZWxkdmFsdWUgPSB0aGlzLl9nZXRfZGVmYXVsdF92YWx1ZShmKTtcbiAgICAgIGlmIChmaWVsZHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihmKSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihmKSA+PSAwKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldGtleScsIGYpKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldGtleScsIGYpKTtcbiAgICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1tmXS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS51bnNldHJlcXVpcmVkJywgZikpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0cmVxdWlyZWQnLCBmKSk7XG4gICAgICAgIH0gZWxzZSByZXR1cm4gZmFsc2U7XG4gICAgICB9IGVsc2UgaWYgKCFzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgfHwgIXNjaGVtYS5maWVsZHNbZl0ucnVsZS5pZ25vcmVfZGVmYXVsdCkge1xuICAgICAgICAvLyBkaWQgc2V0IGEgZGVmYXVsdCB2YWx1ZSwgaWdub3JlIGRlZmF1bHQgaXMgbm90IHNldFxuICAgICAgICBpZiAodGhpcy52YWxpZGF0ZShmLCBmaWVsZHZhbHVlKSAhPT0gdHJ1ZSkge1xuICAgICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuaW52YWxpZGRlZmF1bHR2YWx1ZScsIGZpZWxkdmFsdWUsIGYsIGZpZWxkdHlwZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLmludmFsaWRkZWZhdWx0dmFsdWUnLCBmaWVsZHZhbHVlLCBmLCBmaWVsZHR5cGUpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZHZhbHVlID09PSBudWxsIHx8IGZpZWxkdmFsdWUgPT09IGNxbC50eXBlcy51bnNldCkge1xuICAgICAgaWYgKHNjaGVtYS5rZXkuaW5kZXhPZihmKSA+PSAwIHx8IHNjaGVtYS5rZXlbMF0uaW5kZXhPZihmKSA+PSAwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0a2V5JywgZikpO1xuICAgICAgfSBlbHNlIGlmIChzY2hlbWEuZmllbGRzW2ZdLnJ1bGUgJiYgc2NoZW1hLmZpZWxkc1tmXS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLnVuc2V0cmVxdWlyZWQnLCBmKSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUudW5zZXRyZXF1aXJlZCcsIGYpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZGVudGlmaWVycy5wdXNoKHV0aWwuZm9ybWF0KCdcIiVzXCInLCBmKSk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJWYWwgPSB0aGlzLmNvbnN0cnVjdG9yLl9nZXRfZGJfdmFsdWVfZXhwcmVzc2lvbihmLCBmaWVsZHZhbHVlKTtcbiAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZGJWYWwpICYmIGRiVmFsLnF1ZXJ5X3NlZ21lbnQpIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZGJWYWwucXVlcnlfc2VnbWVudCk7XG4gICAgICAgIHF1ZXJ5UGFyYW1zLnB1c2goZGJWYWwucGFyYW1ldGVyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGRiVmFsKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIHRocm93IChlKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcblxuICBpZiAoZXJyb3JIYXBwZW5lZCkgcmV0dXJuIHt9O1xuXG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdJTlNFUlQgSU5UTyBcIiVzXCIgKCAlcyApIFZBTFVFUyAoICVzICknLFxuICAgIHByb3BlcnRpZXMudGFibGVfbmFtZSxcbiAgICBpZGVudGlmaWVycy5qb2luKCcgLCAnKSxcbiAgICB2YWx1ZXMuam9pbignICwgJyksXG4gICk7XG5cbiAgaWYgKG9wdGlvbnMuaWZfbm90X2V4aXN0KSBxdWVyeSArPSAnIElGIE5PVCBFWElTVFMnO1xuICBpZiAob3B0aW9ucy50dGwpIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgVVNJTkcgVFRMICVzJywgb3B0aW9ucy50dGwpO1xuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICAvLyBzZXQgZHVtbXkgaG9vayBmdW5jdGlvbiBpZiBub3QgcHJlc2VudCBpbiBzY2hlbWFcbiAgaWYgKHR5cGVvZiBzY2hlbWEuYmVmb3JlX3NhdmUgIT09ICdmdW5jdGlvbicpIHtcbiAgICBzY2hlbWEuYmVmb3JlX3NhdmUgPSBmdW5jdGlvbiBmKGluc3RhbmNlLCBvcHRpb24sIG5leHQpIHtcbiAgICAgIG5leHQoKTtcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHNjaGVtYS5hZnRlcl9zYXZlID0gZnVuY3Rpb24gZihpbnN0YW5jZSwgb3B0aW9uLCBuZXh0KSB7XG4gICAgICBuZXh0KCk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogcXVlcnlQYXJhbXMsXG4gICAgICBiZWZvcmVfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYmVmb3JlX3NhdmUodGhpcywgb3B0aW9ucywgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICBob29rQ2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5iZWZvcmUuZXJyb3InLCBlcnJvcikpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBob29rQ2FsbGJhY2soKTtcbiAgICAgICAgfSk7XG4gICAgICB9LFxuICAgICAgYWZ0ZXJfaG9vazogKGhvb2tDYWxsYmFjaykgPT4ge1xuICAgICAgICBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICAgIGhvb2tDYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmFmdGVyLmVycm9yJywgZXJyb3IpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaG9va0NhbGxiYWNrKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0geyBwcmVwYXJlOiBvcHRpb25zLnByZXBhcmUgfTtcbiAgaWYgKG9wdGlvbnMuY29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5jb25zaXN0ZW5jeSA9IG9wdGlvbnMuY29uc2lzdGVuY3k7XG4gIGlmIChvcHRpb25zLmZldGNoU2l6ZSkgcXVlcnlPcHRpb25zLmZldGNoU2l6ZSA9IG9wdGlvbnMuZmV0Y2hTaXplO1xuICBpZiAob3B0aW9ucy5hdXRvUGFnZSkgcXVlcnlPcHRpb25zLmF1dG9QYWdlID0gb3B0aW9ucy5hdXRvUGFnZTtcbiAgaWYgKG9wdGlvbnMuaGludHMpIHF1ZXJ5T3B0aW9ucy5oaW50cyA9IG9wdGlvbnMuaGludHM7XG4gIGlmIChvcHRpb25zLnBhZ2VTdGF0ZSkgcXVlcnlPcHRpb25zLnBhZ2VTdGF0ZSA9IG9wdGlvbnMucGFnZVN0YXRlO1xuICBpZiAob3B0aW9ucy5yZXRyeSkgcXVlcnlPcHRpb25zLnJldHJ5ID0gb3B0aW9ucy5yZXRyeTtcbiAgaWYgKG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3kpIHF1ZXJ5T3B0aW9ucy5zZXJpYWxDb25zaXN0ZW5jeSA9IG9wdGlvbnMuc2VyaWFsQ29uc2lzdGVuY3k7XG5cbiAgc2NoZW1hLmJlZm9yZV9zYXZlKHRoaXMsIG9wdGlvbnMsIChlcnJvcikgPT4ge1xuICAgIGlmIChlcnJvcikge1xuICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5zYXZlLmJlZm9yZS5lcnJvcicsIGVycm9yKSk7XG4gICAgfVxuXG4gICAgdGhpcy5jb25zdHJ1Y3Rvci5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFvcHRpb25zLmlmX25vdF9leGlzdCB8fCAocmVzdWx0LnJvd3MgJiYgcmVzdWx0LnJvd3NbMF0gJiYgcmVzdWx0LnJvd3NbMF1bJ1thcHBsaWVkXSddKSkge1xuICAgICAgICAgIHRoaXMuX21vZGlmaWVkID0ge307XG4gICAgICAgIH1cbiAgICAgICAgc2NoZW1hLmFmdGVyX3NhdmUodGhpcywgb3B0aW9ucywgKGVycm9yMSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcjEpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2UgaWYgKGVycikge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zLCAoZXJyb3IxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yMSkge1xuICAgICAgICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYWZ0ZXIuZXJyb3InLCBlcnJvcjEpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmRlbGV0ZSA9IGZ1bmN0aW9uIGYob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRlbGV0ZVF1ZXJ5ID0ge307XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzY2hlbWEua2V5Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZmllbGRLZXkgPSBzY2hlbWEua2V5W2ldO1xuICAgIGlmIChmaWVsZEtleSBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGZpZWxkS2V5Lmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGRlbGV0ZVF1ZXJ5W2ZpZWxkS2V5W2pdXSA9IHRoaXNbZmllbGRLZXlbal1dO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGVRdWVyeVtmaWVsZEtleV0gPSB0aGlzW2ZpZWxkS2V5XTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5kZWxldGUoZGVsZXRlUXVlcnksIG9wdGlvbnMsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUudG9KU09OID0gZnVuY3Rpb24gdG9KU09OKCkge1xuICBjb25zdCBvYmplY3QgPSB7fTtcbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoZmllbGQpID0+IHtcbiAgICBvYmplY3RbZmllbGRdID0gdGhpc1tmaWVsZF07XG4gIH0pO1xuXG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmlzTW9kaWZpZWQgPSBmdW5jdGlvbiBpc01vZGlmaWVkKHByb3BOYW1lKSB7XG4gIGlmIChwcm9wTmFtZSkge1xuICAgIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5fbW9kaWZpZWQsIHByb3BOYW1lKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fbW9kaWZpZWQpLmxlbmd0aCAhPT0gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQmFzZU1vZGVsO1xuIl19