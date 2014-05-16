﻿var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var CPSProtocol = require('./cps');

var ThunkProtocol = (function (_super) {
    __extends(ThunkProtocol, _super);
    function ThunkProtocol() {
        _super.call(this);
    }
    ThunkProtocol.prototype.invoke = function (func, this_, args) {
        var _this = this;
        return function (callback) {
            args.push(callback || nullFunc);
            _super.prototype.invoke.call(_this, func, this_, args);
        };
    };

    ThunkProtocol.acceptsCallback = false;
    return ThunkProtocol;
})(CPSProtocol);

function nullFunc() {
}
module.exports = ThunkProtocol;
//# sourceMappingURL=thunk.js.map
