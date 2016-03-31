/*!
 * Informix connector for LoopBack
 */
var SqlConnector = require('loopback-connector').SqlConnector;
var ParameterizedSQL = SqlConnector.ParameterizedSQL;
var Driver = require('ibm_db');
var util = require('util');
var debug = require('debug')('loopback:connector:informix');
var async = require('async');

/**
 * Initialize the Informix connector for the given data source
 *
 * @param {DataSource} ds The data source instance
 * @param {Function} [cb] The cb function
 */
exports.initialize = function(ds, cb) {
  ds.connector = new Informix(ds.settings);
  ds.connector.dataSource = ds;
  if (cb) ds.connector.connect(cb);
};

/**
 * The constructor for the Informix LoopBack connector
 *
 * @param {Object} settings The settings object
 * @constructor
 */
function Informix(settings) {
  debug('Informix constructor settings: %j', settings);
  SqlConnector.call(this, 'informix', settings);
  this.debug = settings.debug || debug.enabled;
  this.useLimitOffset = settings.useLimitOffset || false;
  this.client = new Driver.Pool();
  this.dbname = (settings.database || settings.db || 'testdb');
  this.hostname = (settings.hostname || settings.host);
  this.username = (settings.username || settings.user);
  this.password = settings.password;
  this.portnumber = settings.port;
  this.protocol = (settings.protocol || 'TCPIP');

  this.connStr =
    'DRIVER={Informix}' +
    ';DATABASE=' + this.dbname +
    ';HOSTNAME=' + this.hostname +
    ';UID=' + this.username +
    ';PWD=' + this.password +
    ';PORT=' + this.portnumber +
    ';PROTOCOL=' + this.protocol;

  this.schema = this.username;
  if (settings.schema) {
    this.connStr += ';CurrentSchema=' + settings.schema;
    this.schema = settings.schema.toUpperCase();
  }

  // This is less than ideal, better idea would be
  // to extend the propagation of the filter object
  // to executeSQL or pass the options obj around
  this.limitRE = /LIMIT (\d+)/;
  this.offsetRE = /OFFSET (\d+)/;
}

util.inherits(Informix, SqlConnector);

Informix.prototype.tableEscaped = function(model) {
  var escapedName = this.escapeName(this.table(model));
  return escapedName;
};

/**
 * Connect to Informix
 *
 * {Function} [cb] The callback after the connect
 */
Informix.prototype.connect = function(cb) {
  var self = this;

  if (self.hostname === undefined ||
      self.portnumber === undefined ||
      self.username === undefined ||
      self.password === undefined ||
      self.protocol === undefined) {
    console.log('Invalid connection string: ', self.connStr);
    return (cb && cb());
  }

  self.dataSource.connecting = true;
  self.client.open(this.connStr, function(err, con) {
    debug('Informix.prototype.connect (%s) err=%j con=%j', self.connStr, err, con);
    if (err) {
      self.dataSource.connected = false;
      self.dataSource.connecting = false;
      self.dataSource.emit('error', err);
    } else {
      self.connection = con;
      self.dataSource.connected = true;
      self.dataSource.connecting = false;
      self.dataSource.emit('connected');
    }
    cb && cb(err, con);
  });
};

/**
 * Execute the sql statement
 *
 */
Informix.prototype.executeSQL = function(sql, params, options, callback) {
  debug('Informix.prototype.executeSQL (enter)',
        sql, params, options);
  var self = this;
  var conn = self.connection;

  if (options.transaction) {
    conn = options.transaction.connection;
  }

  var limit = 0;
  var offset = 0;
  // This is standard Informix syntax. LIMIT and OFFSET
  // are configured off by default. Enable these to
  // leverage LIMIT and OFFSET.
  if (!this.useLimitOffset) {
    var res = sql.match(self.limitRE);
    if (res) {
      limit = Number(res[1]);
      sql = sql.replace(self.limitRE, '');
    }
    res = sql.match(this.offsetRE);
    if (res) {
      offset = Number(res[1]);
      sql = sql.replace(self.offsetRE, '');
    }
  }

  conn.query(sql, params, function(err, data, more) {
    debug('Informix.prototype.executeSQL (exit)' +
          ' sql=%j params=%j err=%j data=%j more=%j',
          sql, params, err, data, more);
    // schedule callback as there is more code to
    // execute in the informix driver to cleanup the current query
    if (offset || limit) {
      data = data.slice(offset, offset + limit);
    }

    if (!err) {
      if (more) {
        process.nextTick(function() {
          return callback(err, data);
        });
      }
    }

    callback && callback(err, data);
  });
};

/**
 * Escape an identifier such as the column name
 * Informix requires double quotes for case-sensitivity
 *
 * @param {string} name A database identifier
 * @returns {string} The escaped database identifier
 */
Informix.prototype.escapeName = function(name) {
  debug('Informix.prototype.escapeName name=%j', name);
  if (!name) return name;
  name.replace(/["]/g, '""');
  return '"' + name + '"';
};

function dateToInformix(val) {
  var dateStr = val.getFullYear() + '-'
      + fillZeros(val.getMonth() + 1) + '-'
      + fillZeros(val.getDate()) + '-'
      + fillZeros(val.getHours()) + '.'
      + fillZeros(val.getMinutes()) + '.'
      + fillZeros(val.getSeconds()) + '.';
  var ms = val.getMilliseconds();
  if (ms < 10) {
    ms = '00000' + ms;
  } else if (ms < 100) {
    ms = '0000' + ms;
  } else {
    ms = '000' + ms;
  }
  return dateStr + ms;
  function fillZeros(v) {
    return v < 10 ? '0' + v : v;
  }
}

/**
 * Convert property name/value to an escaped DB column value
 *
 * @param {Object} prop Property descriptor
 * @param {*} val Property value
 * @returns {*} The escaped value of DB column
 */
Informix.prototype.toColumnValue = function(prop, val) {
  debug('Informix.prototype.toColumnValue prop=%j val=%j', prop, val);
  if (val === null) {
    if (prop.autoIncrement || prop.id) {
      return new ParameterizedSQL('DEFAULT');
    }
    return null;
  }
  if (!prop) {
    return val;
  }
  switch (prop.type.name) {
    default:
    case 'Array':
    case 'Number':
    case 'String':
      return val;
    case 'Boolean':
      return Number(val);
    case 'GeoPoint':
    case 'Point':
    case 'List':
    case 'Object':
    case 'ModelConstructor':
      return JSON.stringify(val);
    case 'JSON':
      return String(val);
    case 'Date':
      return dateToInformix(val);
  }
};

/*!
 * Convert the data from database column to model property
 *
 * @param {object} Model property descriptor
 * @param {*) val Column value
 * @returns {*} Model property value
 */
Informix.prototype.fromColumnValue = function(prop, val) {
  debug('Informix.prototype.fromColumnValue %j %j', prop, val);
  if (val === null || !prop) {
    return val;
  }
  switch (prop.type.name) {
    case 'Number':
      return Number(val);
    case 'String':
      return String(val);
    case 'Date':
      return new Date(val);
    case 'Boolean':
      return Boolean(val);
    case 'GeoPoint':
    case 'Point':
    case 'List':
    case 'Array':
    case 'Object':
    case 'JSON':
      return JSON.parse(val);
    default:
      return val;
  }
};

/**
 * Get the place holder in SQL for identifiers, such as ??
 *
 * @param {string} key Optional key, such as 1 or id
 */
Informix.prototype.getPlaceholderForIdentifier = function(key) {
  throw new Error('Placeholder for identifiers is not supported: ' + key);
};

/**
 * Get the place holder in SQL for values, such as :1 or ?
 *
 * @param {string} key Optional key, such as 1 or id
 * @returns {string} The place holder
 */
Informix.prototype.getPlaceholderForValue = function(key) {
  debug('Informix.prototype.getPlaceholderForValue key=%j', key);
  return '(?)';
};


/**
 * Build the clause for default values if the fields is empty
 *
 * @param {string} model The model name
 * @returns {string} default values statement
 */
Informix.prototype.buildInsertDefaultValues = function(model) {
  var def = this.getModelDefinition(model);
  var num = Object.keys(def.properties).length;
  var result = '';
  if (num > 0) result = 'DEFAULT';
  for (var i = 1; i < num && num > 1; i++) {
    result = result.concat(',DEFAULT');
  }
  return 'VALUES(' + result + ')';
};

/**
 * Create the table for the given model
 *
 * @param {string} model The model name
 * @param {Object} [options] options
 * @param {Function} [cb] The callback function
 */
Informix.prototype.createTable = function(model, options, cb) {
  debug('Informix.prototype.createTable ', model, options);
  cb();
};

Informix.prototype.buildIndex = function(model, property) {
  debug('Informix.prototype.buildIndex %j %j', model, property);
};

Informix.prototype.buildIndexes = function(model) {
  debug('Informix.prototype.buildIndexes %j', model);
};

/**
 * Create the data model in Informix
 *
 * @param {string} model The model name
 * @param {Object} data The model instance data
 * @param {Object} options Options object
 * @param {Function} [callback] The callback function
 */
Informix.prototype.create = function(model, data, options, callback) {
  var self = this;
  var stmt = self.buildInsert(model, data, options);
  var id = self.idName(model);
  var sql = 'SELECT \"' + id + '\" FROM FINAL TABLE (' + stmt.sql + ')';
  self.execute(sql, stmt.params, options, function(err, info) {
    if (err) {
      callback(err);
    } else {
      callback(err, info[0][id]);
    }
  });
};

/**
 * Update all instances that match the where clause with the given data
 *
 * @param {string} model The model name
 * @param {Object} where The where object
 * @param {Object} data The property/value object representing changes
 * to be made
 * @param {Object} options The options object
 * @param {Function} cb The callback function
 */
Informix.prototype.update = function(model, where, data, options, cb) {
  var self = this;
  var stmt = self.buildUpdate(model, where, data, options);
  var id = self.idName(model);
  var sql = 'SELECT \"' + id + '\" FROM FINAL TABLE (' + stmt.sql + ')';
  self.execute(sql, stmt.params, options, function(err, info) {
    if (cb) {
      cb(err, {count: info.length});
    }
  });
};

/**
 * Update if the model instance exists with the same id or create a new instance
 *
 * @param {string} model The model name
 * @param {Object} data The model instance data
 * @param {Function} [callback] The callback function
 */
Informix.prototype.updateOrCreate = Informix.prototype.save =
  function(model, data, options, callback) {
    var self = this;
    var fields = self.buildFields(model, data);
    var id = self.idName(model);
    var sql = new ParameterizedSQL('MERGE INTO ' +
                                   self.schema.toUpperCase() + '.' +
                                   self.tableEscaped(model));
    var columnValues = fields.columnValues;
    var fieldNames = fields.names;
    var setValues = [];

    var definition = self.getModelDefinition(model);

    if (fieldNames.length) {
      sql.merge('AS MT(');

      Object.keys(definition.properties).forEach(function(prop) {
        setValues.push(new ParameterizedSQL(self.columnEscaped(model, prop)));
      });

      var columns = ParameterizedSQL.join(setValues, ',');
      sql.merge(columns);
      sql.merge(')');
      sql.merge('USING (SELECT * FROM TABLE( VALUES(');

      setValues = [];
      for (var i = 0, n = fields.names.length; i < n; i++) {
        setValues.push(new ParameterizedSQL('CAST (' + columnValues[i].sql +
          ' AS ' +
          self.buildColumnType(fields.properties[i]) + ')',
          columnValues[i].params));

        if (i < (n - 1))
          setValues[i].sql = setValues[i].sql + ',';
      }

      sql.merge(setValues);
      sql.merge('))) AS VT(' + fieldNames.join(',') + ')');
      sql.merge('ON');
      sql.merge('(MT.\"' + id + '\" = VT.\"' + id + '\")');
      sql.merge('WHEN NOT MATCHED THEN INSERT (' +
      fieldNames.join(',') + ')');

      var values = ParameterizedSQL.join(columnValues, ',');
      values.sql = 'VALUES(' + values.sql + ')';
      sql.merge(values);
    } else {
      sql.merge(self.buildInsertDefaultValues(model, data, options));
    }

    sql.merge('WHEN MATCHED THEN UPDATE SET');

    setValues = [];
    for (i = 0, n = fields.names.length; i < n; i++) {
      if (!fields.properties[i].id) {
        setValues.push(new ParameterizedSQL(fields.names[i] + '=' +
          '(' + columnValues[i].sql + ')', columnValues[i].params));
      }
    }

    sql.merge(ParameterizedSQL.join(setValues, ','));

    self.execute(sql.sql, sql.params, options, function(err, info) {
      if (!err && info && info.insertId) {
        data.id = info.insertId;
      }
      var meta = {};
      if (info) {
        // When using the INSERT ... ON DUPLICATE KEY UPDATE statement,
        // the returned value is as follows:
        // 1 for each successful INSERT.
        // 2 for each successful UPDATE.
        meta.isNewInstance = (info.affectedRows === 1);
      }

      callback(err, data, meta);
    });
  };

/**
 * Delete all matching model instances
 *
 * @param {string} model The model name
 * @param {Object} where The where object
 * @param {Object} options The options object
 * @param {Function} cb The callback function
 */
Informix.prototype.destroyAll = function(model, where, options, cb) {
  var self = this;
  var stmt = self.buildDelete(model, where, options);
  var id = self.idName(model);
  var sql = 'SELECT \"' + id + '\" FROM OLD TABLE (' + stmt.sql + ')';
  self.execute(sql, stmt.params, options, function(err, info) {
    if (cb) {
      cb(err, {count: info.length});
    }
  });
};

function buildLimit(limit, offset) {
  if (isNaN(limit)) { limit = 0; }
  if (isNaN(offset)) { offset = 0; }
  if (!limit && !offset) {
    return '';
  }
  if (limit && !offset) {
    return 'FETCH FIRST ' + limit + ' ROWS ONLY';
  }
  if (offset && !limit) {
    return 'OFFSET ' + offset;
  }
  return 'LIMIT ' + limit + ' OFFSET ' + offset;
}

Informix.prototype.applyPagination = function(model, stmt, filter) {
  debug('Informix.prototype.applyPagination');
  var limitClause = buildLimit(filter.limit, filter.offset || filter.skip);
  return stmt.merge(limitClause);
};


Informix.prototype.getCountForAffectedRows = function(model, info) {
  var affectedRows = info && typeof info.affectedRows === 'number' ?
      info.affectedRows : undefined;
  return affectedRows;
};

/**
 * Drop the table for the given model from the database
 *
 * @param {string} model The model name
 * @param {Function} [cb] The callback function
 */
Informix.prototype.dropTable = function(model, cb) {
  var self = this;
  var sql =
      'BEGIN\nDECLARE CONTINUE HANDLER FOR SQLSTATE \'42704\'\n' +
      'BEGIN END;\nEXECUTE IMMEDIATE \'DROP TABLE ' +
      self.schema + '.' + self.tableEscaped(model) + '\';\nEND';
  self.execute(sql, cb);
};

Informix.prototype.createTable = function(model, cb) {
  var self = this;
  var tableName = self.tableEscaped(model);
  var tableSchema = self.schema;
  var columnDefinitions = self.buildColumnDefinitions(model);
  var tasks = [];

  if (self.supportColumnStore && self.supportColumnStore === true) {
    return cb(new Error('Column organized tables are not ' +
                        'currently supported'));
  } else if (self.supportDashDB) {
    tasks.push(function(callback) {
      var sql = 'CREATE TABLE ' + tableSchema + '.' + tableName +
          ' (' + columnDefinitions + ') ORGANIZE BY ROW;';
      self.execute(sql, callback);
    });
  } else {
    tasks.push(function(callback) {
      var sql = 'CREATE TABLE ' + tableSchema + '.' + tableName +
          ' (' + columnDefinitions + ');';
      self.execute(sql, callback);
    });
  }

  var indexes = self.buildIndexes(model);
  indexes.forEach(function(i) {
    tasks.push(function(callback) {
      self.execute(i, callback);
    });
  });

  async.series(tasks, cb);
};

Informix.prototype.buildColumnDefinitions = function(model) {
  var self = this;
  var sql = [];
  var definition = this.getModelDefinition(model);
  var pks = this.idNames(model).map(function(i) {
    return self.columnEscaped(model, i);
  });
  Object.keys(definition.properties).forEach(function(prop) {
    var colName = self.columnEscaped(model, prop);
    sql.push(colName + ' ' + self.buildColumnDefinition(model, prop));
  });
  if (pks.length > 0) {
    sql.push('PRIMARY KEY(' + pks.join(',') + ')');
  }

  return sql.join(',\n');
};

Informix.prototype.buildIndex = function(model, property) {
  var self = this;
  // var prop = self.getModelDefinition(model).properties[property];
  var prop = self.getPropertyDefinition(model, property);
  var i = prop && prop.index;
  if (!i) {
    return '';
  }

  var stmt = 'CREATE ';
  var kind = '';
  if (i.kind) {
    kind = i.kind;
  }
  var columnName = self.columnEscaped(model, property);
  if (typeof i === 'object' && i.unique && i.unique === true) {
    kind = 'UNIQUE';
  }
  return (stmt + kind + ' INDEX ' + columnName +
          ' ON ' + self.schema + '.' + self.tableEscaped(model) +
          ' (' + columnName + ');\n');
};

Informix.prototype.buildIndexes = function(model) {
  var indexClauses = [];
  var definition = this.getModelDefinition(model);
  var indexes = definition.settings.indexes || {};
  // Build model level indexes
  for (var index in indexes) {
    var i = indexes[index];
    var stmt = 'CREATE ';
    var kind = '';
    if (i.kind) {
      kind = i.kind;
    }
    var indexedColumns = [];
    var indexName = this.escapeName(index);
    if (Array.isArray(i.keys)) {
      indexedColumns = i.keys.map(function(key) {
        return this.columnEscaped(model, key);
      });
    }

    var columns = (i.columns.split(/,\s*/)).join('\",\"');
    if (indexedColumns.length > 0) {
      columns = indexedColumns.join('\",\"');
    }

    indexClauses.push(stmt + kind + ' INDEX ' + indexName +
                      ' ON ' + this.schema + '.' + this.tableEscaped(model) +
                      ' (\"' + columns + '\");\n');
  }

  // Define index for each of the properties
  // for (var p in definition.properties) {
  //   var propIndex = this.buildIndex(model, p);
  //   if (propIndex) {
  //     indexClauses.push(propIndex);
  //   }
  // }

  return indexClauses;
};

Informix.prototype.buildColumnDefinition = function(model, prop) {
  // var p = this.getModelDefinition(model).properties[prop];
  var p = this.getPropertyDefinition(model, prop);
  if (p.id && p.generated) {
    return 'INT NOT NULL GENERATED BY DEFAULT' +
      ' AS IDENTITY (START WITH 1 INCREMENT BY 1)';
  }
  var line = this.columnDataType(model, prop) + ' ' +
      (this.isNullable(p) ? 'NULL' : 'NOT NULL');
  return line;
};

Informix.prototype.columnDataType = function(model, property) {
  var prop = this.getPropertyDefinition(model, property);
  if (!prop) {
    return null;
  }
  return this.buildColumnType(prop);
};

Informix.prototype.buildColumnType = function buildColumnType(propertyDefinition) {
  var self = this;
  var dt = '';
  var p = propertyDefinition;
  var type = p.type.name;

  switch (type) {
    default:
    case 'JSON':
    case 'Object':
    case 'Any':
    case 'Text':
    case 'String':
      dt = self.convertTextType(p, 'VARCHAR');
      break;
    case 'Number':
      dt = self.convertNumberType(p, 'INTEGER');
      break;
    case 'Date':
      dt = 'TIMESTAMP';
      break;
    case 'Boolean':
      dt = 'SMALLINT';
      break;
    case 'Point':
    case 'GeoPoint':
      dt = 'POINT';
      break;
    case 'Enum':
      dt = 'ENUM(' + p.type._string + ')';
      dt = stringOptions(p, dt);
      break;
  }
  debug('Informix.prototype.buildColumnType %j %j', p.type.name, dt);
  return dt;
};

Informix.prototype.convertTextType = function convertTextType(p, defaultType) {
  var self = this;
  var dt = defaultType;
  var len = p.length ||
    ((p.type !== String) ? 4096 : p.id ? 255 : 512);

  if (p[self.name]) {
    if (p[self.name].dataLength) {
      len = p[self.name].dataLength;
    }
  }

  if (p[self.name] && p[self.name].dataType) {
    dt = String(p[self.name].dataType);
  } else if (p.dataType) {
    dt = String(p.dataType);
  }

  dt += '(' + len + ')';

  stringOptions(p, dt);

  return dt;
};

Informix.prototype.convertNumberType = function convertNumberType(p, defaultType) {
  var self = this;
  var dt = defaultType;
  var precision = p.precision;
  var scale = p.scale;

  if (p[self.name] && p[self.name].dataType) {
    dt = String(p[self.name].dataType);
    precision = p[self.name].dataPrecision;
    scale = p[self.name].dataScale;
  } else if (p.dataType) {
    dt = String(p.dataType);
  } else {
    return dt;
  }

  switch (dt) {
    case 'DECIMAL':
      dt = 'DECIMAL';
      if (precision && scale) {
        dt += '(' + precision + ',' + scale + ')';
      } else if (scale > 0) {
        throw new Error('Scale without Precision does not make sense');
      }
      break;
    default:
      break;
  }

  return dt;
};

function stringOptions(p, columnType) {
  if (p.charset) {
    columnType += ' CHARACTER SET ' + p.charset;
  }
  if (p.collation) {
    columnType += ' COLLATE ' + p.collation;
  }
  return columnType;
}

require('./migration')(Informix);
require('./discovery')(Informix);
require('./transaction')(Informix);
