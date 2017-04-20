var fs = require('fs')
var p  = require('path')


function readdir(path, callback) {

  var list = [];

  fs.readdir(path, function (err, files) {
    if (err) {
      return callback(err)
    }

    var pending = files.length;
    if (!pending) {
      // we are done, woop woop
      return callback(null, list)
    }

    files.forEach(function (file) {
      var filePath = p.join(path, file)
      fs.stat(filePath, function (_err, stats) {
        if (_err) {
          return callback(_err)
        }

        if (stats.isDirectory()) {
          readdir(filePath, function (__err, res) {
            if (__err) {
              return callback(__err)
            }

            list = list.concat(res)
            pending -= 1
            if (!pending) {
              return callback(null, list)
            }
          })
        } else {
          list.push(filePath)
          pending -= 1
          if (!pending) {
            return callback(null, list)
          }
        }

      })
    })
  })
}

module.exports = readdir
