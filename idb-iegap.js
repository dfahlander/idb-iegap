if (navigator.userAgent.indexOf("Trident/") !== -1) (function (idb, undefined) {
    /* IndexedDB IE Gap polyfill (idb-iegap.js)
     *
     * $Format:%d$
     * 
     * Gaps if IE10 and IE11:
     *      * The lack of support for compound indexes
     *      * The lack of support for compound primary keys
     *      * The lack of support for multiEntry indexes
     *      * Always returning false from property IDBObjectStore.autoIncrement 
     *
     *
     * Where to inject?
     * 
     *      Everything that is implemented is marked with a "V" below:
     *
     *      V IDBObjectStore.createIndex(name, [keyPath1, keypath2], { unique: true/false, multiEntry: true });
     *          What to do?
     *              1) If keyPath is an array, create a new table ($iegap-<table>-<indexName> with autoinc, key "key" (unique?) and value "primKey" of this table
     *                 If multiEntry is true, create a new table ($iegap-<table>-<indexName> with autoinc, key "key" and value "primKey" of this table.
     *              2) Dont create the real index but store the index in localStorage key ("$iegap-<table>")
     *                  { indexes: [{name: "", keyPath, ...
     *      V IDBObjectStore.deleteIndex()
     *      V IDBObjectStore.index("name")
     *          V If the name corresponds to a special index, return a fake IDBIndex with its own version of openCursor()
     *      V IDBObjectStore.add():
     *          V If we have compound indexes, make sure to also add an item in its table if add was successful. Return a fake request that resolves when both requests are resolved
                  V Ignore but log error events occurring when adding index keys
     *          V If we have multiEntry indexes, make sure to also interpret the array and add all its items. Same rule as above.
     *      V IDBObjectStore.put():
     *          V First delete all indexed-items bound to this primary key, then do the add.
     *      V IDBObjectStore.delete(): Delete all indexed items bound to this primary key.
     *      V IDBObjectStore.clear(): Clear all meta stores bound to this object store.
     *      V IDBKeyRange.*: Allow arrays and store them in range.compound value.
     *      V IEGAPIndex.openKeyCursor():
     *          V compound: Iterate the own table, use a fake cursor object to point out correct primary key
     *      V IEGAPIndex.openCursor():
     *          V compound: Iterate the own table, use a fake cursor object to point out correct primary key and value
     *          V IEGapCursor.delete(): delete the object itself along with the index objects pointing to it. HOW WILL IE REACT WHEN SAWING OF ITS OWN BRANCH IN AN ITERATION. We might have to restart the query with another upperBound/lowerBound request.
     *          V IEGapCursor.update(): Do a put() on the object itself. WHAT HAPPENS IF PUT/DELETE results in deleting next-coming iterations? We might have to restart the quer with another upperBound/lowerBound request.
     *          V Support nextunique and prevunique by just using it on the index store.
     *      V IDBDatabase.transaction(): Make sure to include all meta-tables for included object stores.
     *      V IDBDatabase.deleteObjectStore(): Delete the meta-indexe object stores and update the meta-table.
     *      V Detect IE10/IE11.
     *
     *  Over-course:
     *      V IDBObjectStore.indexNames: Return the compound result of real indexNames and the ones in $iegap-<table>-indexes
     *      V IDBDatabase.objectStoreNames: Filter away those names that contain metadata
     *      V indexedDB.open(): extend the returned request and override onupgradeneeded so that main meta-table is created
     *      V                            "                               onsuccess so that the main meta-table is read into a var stored onto db.
     *      V IDBTransaction.objectStore(): Populate the "autoIncrement" property onto returned objectStore. Need to have that stored if so.
     *      V readyState in IEGAPRequest
     */
    function extend(obj, extension) {
        if (typeof extension !== 'object') extension = extension(); // Allow to supply a function returning the extension. Useful for simplifying private scopes.
        Object.keys(extension).forEach(function(key) {
            obj[key] = extension[key];
        });
        return obj;
    }

    function derive(Child) {
        return {
            from: function(Parent) {
                Child.prototype = Object.create(Parent.prototype);
                Child.prototype.constructor = Child;
                return {
                    extend: function(extension) {
                        extend(Child.prototype, typeof extension !== 'object' ? extension(Parent.prototype) : extension);
                    }
                };
            }
        };
    }

    function override(orig, overrider) {
        if (typeof orig === 'object')
            // map of properties to override
            Object.keys(overrider).forEach(function (prop) {
                var pd = Object.getOwnPropertyDescriptor(orig, prop);
                var newPd = overrider[prop](pd);
                if (newPd.hasOwnProperty('value') && newPd.writable !== false) newPd.writable = true;
                Object.defineProperty(orig, prop, extend({ configurable: true, enumerable: true }, newPd));
            }); 
        else
            // simple function
            return overrider(orig);
    }

    function getByKeyPath(obj, keyPath) {
        // http://www.w3.org/TR/IndexedDB/#steps-for-extracting-a-key-from-a-value-using-a-key-path
        if (obj.hasOwnProperty(keyPath)) return obj[keyPath]; // This line is moved from last to first for optimization purpose.
        if (!keyPath) return obj;
        if (typeof keyPath !== 'string') {
            var rv = [];
            for (var i = 0, l = keyPath.length; i < l; ++i) {
                var val = getByKeyPath(obj, keyPath[i]);
                rv.push(val);
            }
            return rv;
        }
        var period = keyPath.indexOf('.');
        if (period !== -1) {
            var innerObj = obj[keyPath.substr(0, period)];
            return innerObj === undefined ? undefined : getByKeyPath(innerObj, keyPath.substr(period + 1));
        }
        return undefined;
    }

    function setByKeyPath(obj, keyPath, value) {
        if (!obj || keyPath === undefined) return;
        if (Array.isArray(keyPath)) {
            for (var i = 0, l = keyPath.length; i < l; ++i) {
                setByKeyPath(obj, keyPath[i], value[i]);
            }
        } else {
            var period = keyPath.indexOf('.');
            if (period !== -1) {
                var currentKeyPath = keyPath.substr(0, period);
                var remainingKeyPath = keyPath.substr(period + 1);
                if (remainingKeyPath === "")
                    if (value === undefined) delete obj[currentKeyPath]; else obj[currentKeyPath] = value;
                else {
                    var innerObj = obj[currentKeyPath];
                    if (!innerObj) innerObj = (obj[currentKeyPath] = {});
                    setByKeyPath(innerObj, remainingKeyPath, value);
                }
            } else {
                if (value === undefined) delete obj[keyPath]; else obj[keyPath] = value;
            }
        }
    }

    function delByKeyPath(obj, keyPath) {
        setByKeyPath(obj, keyPath, undefined);
    }

    function deepClone(any) {
        if (!any || typeof any !== 'object') return any;
        var rv;
        if (Array.isArray(any)) {
            rv = [];
            for (var i = 0, l = any.length; i < l; ++i) {
                rv.push(deepClone(any[i]));
            }
        } else if (any instanceof Date) {
            rv = new Date();
            rv.setTime(any.getTime());
        } else {
            rv = any.constructor ? Object.create(any.constructor.prototype) : {};
            for (var prop in any) {
                if (any.hasOwnProperty(prop)) {
                    rv[prop] = deepClone(any[prop]);
                }
            }
        }
        return rv;
    }

    // TODO: Remove this?
    function ignore(op, cb) {
        return function (ev) {
            if (op) console.log("Warning: IEGap polyfill failed to " + (op.call ? op() : op) + ": " + ev.target.error);
            ev.stopPropagation();
            ev.preventDefault();
            if (cb) cb(ev);
            return false;
        }
    }

    function generateIndexRecords(transaction, obj, indexMeta, outOperations) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="obj" type="Object">Object to index</param>
        /// <param name="indexMeta" type="IIndexMeta">Index specification of the index type</param>
        /// <param name="outOperations" type="Array" elementType="IOperation">out: Operations that would do the job</param>
        if (indexMeta.compound) {
            var idxKeys = getByKeyPath(obj, indexMeta.keyPath);
            if (idxKeys !== undefined) {
                var store = indexMeta.
                outOperations.push({store: , op: , args: });
            }
        } else if (indexMeta.multiEntry) {
            
        }
    }

    // TODO: Remove this!
    function addCompoundIndexKey(idxStore, indexSpec, value, primKey, rollbacks, onfinally) {
        /// <param name="idxStore" type="IDBObjectStore">The object store for meta-indexes</param>
        try {
            var idxKeys = getByKeyPath(value, indexSpec.keyPath);
            if (idxKeys === undefined) return onfinally(); // no key to add index for
            var req = idxStore.add({ fk: primKey, k: compoundToString(idxKeys) });
            req.onerror = ignore("add compound index", onfinally);
            req.onsuccess = function (ev) {
                if (rollbacks) rollbacks.push({store: idxStore, op: "delete", args: [ev.target.result]});
                onfinally();
            };
        } catch (ex) {
            console.log("IEGap polyfill exception when adding compound index key");
            onfinally();
        }
    }

    // TODO: Remove this!
    function addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, rollbacks, onfinally) {
        /// <param name="idxStore" type="IDBObjectStore">The object store for meta-indexes</param>
        try {
            var idxKeys = getByKeyPath(value, indexSpec.keyPath);
            if (idxKeys === undefined) return onfinally(); // no key to add index for.
            if (!Array.isArray(idxKeys)) {
                // the result of evaluating the index's key path doesn't yield an Array
                var req = idxStore.add({ fk: primKey, k: idxKeys });
                req.onerror = ignore("add index", onfinally);
                req.onsuccess = function(ev) {
                    if (rollbacks) rollbacks.push({store: idxStore, op: "delete", args: [ev.target.result]});
                    onfinally();
                }
            } else {
                // the result of evaluating the index's key path yields an Array
                idxKeys.forEach(function(idxKey) {
                    var req2 = idxStore.add({ fk: primKey, k: idxKey });
                    req2.onerror = ignore(function() { return "add multiEntry index " + idxKey + " for " + indexSpec.storeName + "." + indexSpec.keyPath ; }, checkComplete);
                    req2.onsuccess = function(ev) {
                        if (rollbacks) rollbacks.push({ store: idxStore, op: "delete", args: [ev.target.result] });
                        checkComplete();
                    }
                });

                var nRequests = idxKeys.length;
                function checkComplete() {
                    if (--nRequests === 0) onfinally();
                }
            }
        } catch (ex) {
            console.log("IEGap polyfill exception when adding multientry key");
        }
    }

    // TODO: Remove this!
    function bulkDelete(index, key, onfinally) {
        /// <param name="index" type="IDBIndex"></param>
        /// <param name="key"></param>
        var cursorReq = index.openKeyCursor(key);
        var primKeys = [];
        cursorReq.onerror = ignore("list indexed references", onfinally);
        cursorReq.onsuccess = function (ev) {
            var cursor = cursorReq.result;
            if (!cursor) return doDelete();
            primKeys.push(cursor.primaryKey);
            cursor.continue();
        }

        function doDelete() {
            var store = index.objectStore;
            primKeys.forEach(function (primKey) {
                var req = store.delete(primKey);
                req.onerror = ignore("delete meta index", checkComplete);
                req.onsuccess = checkComplete;
            });
            var nRequests = primKeys.length;
            if (nRequests === 0) onfinally();
            function checkComplete() {
                if (--nRequests === 0) onfinally();
            }
        }
    }

    function bulk(operations, cb) {
        /// <summary>
        ///     Execute given array of operations and the call given callback
        /// </summary>
        /// <param name="operations" type="Array" elementType="IOperation">Operations to execute</param>
        /// <param name="cb" value="function(successCount){}"></param>
        var nRequests = operations.length,
            successCount = 0;

        operations.forEach(function(item) {
            var req = origObjectStorePrototype[item.op].apply(item.store, item.args);
            req.onsuccess = function(ev) {
                item.result = ev.target.result;
                ++successCount;
                checkComplete();
            }
            req.onerror = function(ev) {
                ev.stopPropagation();
                ev.preventDefault();
                item.error = ev.target.error;
                checkComplete();
            }
        });

        function checkComplete(ev) {
            if (--nRequests === 0 && cb) cb(successCount);
        }
    }

    //
    // Constants and imports
    //
    var POWTABLE = {};
    var IDBKeyRange = window.IDBKeyRange,
        IDBObjectStore = window.IDBObjectStore,
        IDBDatabase = window.IDBDatabase;

    var origObjectStorePrototype = {};
    extend(origObjectStorePrototype, IDBObjectStore.prototype);


    function initPowTable() {
        for (var i = 4; i >= -4; --i) {
            POWTABLE[i] = Math.pow(32768, i);
        }
    }

    function unipack(number, intChars, floatChars) {
        /// <summary>
        ///     Represent the number as a unicode string keeping the sort
        ///     order of the Number instance intact when comparing the
        ///     resulting string.
        /// </summary>
        /// <param name="number" type="Number">Number to represent as sort-order kept unicode string</param>
        /// <param name="intChars" type="Number">Number of unicode chars that should represent the integer part of given Number.
        /// Each unicode char will hold 15 bits (16 - 1, since 0000 is an unusable char making us lose one bit of info per char.</param>
        /// <param name="floatChars" type="Number">Number of unicode chars that should represent the floating point decimals of
        /// given Number instance. Each char will hold 15 bits.</param>
        var currPow = intChars - 1,
            xor = number < 0 ? 32767 : 0,
            unsignedNumber = number < 0 ? -number : number,
            rv = "";

        while (currPow >= -floatChars) {
            var val = ((unsignedNumber / POWTABLE[currPow]) & 32767) ^ xor;
            var charCode = (val << 1) | 1;
            rv += String.fromCharCode(charCode);
            --currPow;
        }
        
        return rv;
    }

    function uniback(unicode, intChars, floatChars, negate) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="unicode" type="String"></param>
        /// <param name="intChars"></param>
        /// <param name="floatChars"></param>
        var rv = 0,
            currPow = intChars - 1,
            l = unicode.length;
        if (intChars + floatChars != l) return undefined;

        for (var i = 0; i < l; ++i) {
            var val = ((unicode.charCodeAt(i) - 1) >> 1);
            if (negate)
                rv -= POWTABLE[currPow] * (val ^ 32767);
            else
                rv += POWTABLE[currPow] * val;
            --currPow;
        }
        return rv;
    }

    function compoundToString(a) {
        /// <param name="a" type="Array"></param>
        var l = a.length,
            rv = new Array(l);
        for (var i = 0; i < l; ++i) {
            var part = a[i];
            if (part instanceof Date)
                rv[i] = "D" + unipack(part.getTime(), 4, 0);
            else if (typeof part === 'string')
                rv[i] = "S" + part;
            else if (isNaN(part))
                if (part)
                    rv[i] = "J" + JSON.stringify(part);
                else if (typeof part === 'undefined')
                    rv[i] = "u"; // undefined
                else
                    rv[i] = "0"; // null
            else
                rv[i] = (part < 0 ? "N" : "n") + unipack(part, 5, 4);
        }
        return JSON.stringify(rv);
    }

    function stringToCompound(s) {
        var a = JSON.parse(s),
            l = a.length,
            rv = new Array(l);
        for (var i = 0; i < l; ++i) {
            var item = a[i];
            var type = item[0];
            var encoded = item.substr(1);
            var value = undefined;
            if (type === "D")
                value = new Date(uniback(encoded, 4, 0));
            else if (type === "J")
                value = JSON.parse(encoded);
            else if (type === "S")
                value = encoded;
            else if (type === "N")
                value = uniback(encoded, 5, 4, true);
            else if (type === "n")
                value = uniback(encoded, 5, 4, false);
            else if (type === "u")
                value = undefined;
            else if (type === "0")
                value = null
            rv[i] = value;
        }
        return rv;
    }

    function getMeta(store) {
        /// <param name="store" type="IDBObjectStore"></param>
        /// <returns type="IStoreMeta"></returns>
        return store.transaction.db._iegapmeta.stores[store.name];
    }
    function setMeta(db, transaction, value) {
        /// <param name="db" type="IDBDatabase"></param>
        /// <param name="transaction" type="IDBTransaction"></param>
        db._iegapmeta = value;
        transaction.objectStore('$iegapmeta').put(value, 1);
    }

    function parseKeyParam(key) {
        if (Array.isArray(key)) return compoundToString(key);
        if (key instanceof IEGAPKeyRange) {
            var upper = Array.isArray(key.upper) ? compoundToString(key.upper) : key.upper,
                lower = Array.isArray(key.lower) ? compoundToString(key.lower) : key.lower;
            if (key.lower === null)
                return IDBKeyRange.upperBound(upper, key.upperOpen);
            if (key.upper === null)
                return IDBKeyRange.lowerBound(lower, key.lowerOpen);
            return IDBKeyRange.bound(
                lower,
                upper,
                !!key.lowerOpen,
                !!key.upperOpen);
        }
        return key;
    }

    function IEGAPIndex(idbIndex, idbStore, name, keyPath, multiEntry) {
        this._idx = idbIndex;
        this._store = idbStore;
        this._compound = Array.isArray(keyPath);
        this._multiEntry = multiEntry;
        this.keyPath = keyPath;
        this.name = name;
        this.objectStore = idbStore;
        this.unique = idbIndex.unique;
    }

    derive(IEGAPIndex).from(Object).extend(function() {
        function openCursor(iegIndex, range, dir, includeValue) {
            /// <param name="iegIndex" type="IEGAPIndex"></param>
            /// <param name="range" type="IDBKeyRange"></param>
            /// <param name="dir" type="String"></param>
            return new BlockableIDBRequest(iegIndex, iegIndex.objectStore, function (success, error) {
                var compound = iegIndex._compound,
                    compoundPrimKey = Array.isArray(iegIndex.objectStore.keyPath);
                if (compound && Array.isArray(range)) range = new IEGAPKeyRange(range, range);
                var idbRange = compound && range ?
                    IDBKeyRange.bound(compoundToString(range.lower), compoundToString(range.upper), range.lowerOpen, range.upperOpen) :
                    range;

                if (typeof idbRange === 'undefined') idbRange = null;
                var req = iegIndex._idx.openCursor(idbRange, dir);
                req.onerror = error;
                if (includeValue) {
                    req.onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        if (cursor) {
                            var getreq = iegIndex._store.get(cursor.value.fk);
                            getreq.onerror = error;
                            getreq.onsuccess = function () {
                                if (!getreq.result) return cursor.continue(); // An index is about to be deleted but it hasnt happened yet.
                                var key = compound ? stringToCompound(cursor.key) : cursor.key;
                                var primKey = compoundPrimKey ? stringToCompound(cursor.value.fk) : cursor.value.fk;
                                success(ev, new IEGAPCursor(cursor, iegIndex, iegIndex.objectStore, primKey, key, getreq.result));
                            }
                        } else {
                            success(ev, null);
                        }
                    }
                } else {
                    req.onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        var key = compound ? stringToCompound(cursor.key) : cursor.key;
                        var primKey = compoundPrimKey ? stringToCompound(cursor.value.fk) : cursor.value.fk;
                        success(ev, cursor && new IEGAPCursor(cursor, iegIndex, iegIndex.objectStore, primKey, key));
                    }
                }
            });
        }

        return {
            count: function (key) {
                if (arguments.length > 0) arguments[0] = parseKeyParam(key);
                var thiz = this;
                return new BlockableIDBRequest(this, this.objectStore, function(success, error) {
                    var req = thiz._idx.count.apply(this._idx, arguments);
                    req.onsuccess = success;
                    req.onerror = error;
                });
            },
            get: function(key) {
                var thiz = this;
                return new BlockableIDBRequest(this, this.objectStore, function (success, error) {
                    var req = thiz._idx.get(parseKeyParam(key));
                    // First request the meta-store for this index
                    req.onsuccess = function(ev) {
                        // Check if key was found. 
                        var foreignKey = req.result && req.result.fk;
                        if (foreignKey) {
                            // Key found. Do a new request on the origin store based on the foreignKey found in meta-store.
                            req = thiz.objectStore.get(foreignKey);
                            req.onsuccess = function () {
                                success(ev, req.result);
                            }
                            req.onerror = error;
                        } else {
                            // Key not found. Just forward the undefined-found index. 
                            success(ev);
                        }
                    }
                    req.onerror = error;
                });
            },
            getKey: function(key) {
                var thiz = this;
                return new BlockableIDBRequest(this, this.objectStore, function (success, error) {
                    var req = thiz._idx.get(parseKeyParam(key));
                    req.onsuccess = function (ev) {
                        var res = ev.target.result;
                        success(ev, res && res.fk);
                    }
                    req.onerror = error;
                });
            },
            openKeyCursor: function(range, dir) {
                return openCursor(this, range, dir);
            },
            openCursor: function(range, dir) {
                return openCursor(this, range, dir, true);
            }
        };
    });

    function IEGAPCursor(idbCursor, source, store, primaryKey, key, value) {
        this._cursor = idbCursor;
        this._store = store;
        this.direction = idbCursor.direction;
        this.key = key;
        this.primaryKey = primaryKey;
        this.source = source;
        if (arguments.length >= 6) this.value = value;
    }

    extend(IEGAPCursor.prototype, function() {
        return {
            advance: function (n) {
                var thiz = this;
                whenUnblocked(this._store.transaction, function() {
                    thiz._cursor.advance(n);
                });
            },
            "continue": function(key) {
                /// <param name="key" optional="true"></param>
                var thiz = this;
                whenUnblocked(this._store.transaction, function() {
                    if (!key) return thiz._cursor.continue();
                    if (Array.isArray(key)) return thiz._cursor.continue(compoundToString(key));
                    return thiz._cursor.continue(key);
                });
            },
            "delete": function () {
                // lock not needed. this._store.delete() will target our rewritten delete
                return this._store.delete(this.primaryKey);// Will automatically delete and iegap index items as well.
            },
            update: function (newValue) {
                // lock not needed. this._store.put() will target our rewritten put
                return this._store.keyPath ? this._store.put(newValue) : this._store.put(newValue, this.primaryKey);
            }
        }
    });

    function IEGAPEventTarget() {
        this._el = {}; // Event Listeners
    }

    extend(IEGAPEventTarget.prototype, function() {
        return {
            addEventListener: function (type, listener) {
                this._el[type] ? this._el[type].push(listener) : this._el[type] = [listener];
            },
            removeEventListener: function (type, listener) {
                var listeners = this._el[type];
                if (listeners) {
                    var pos = listeners.indexOf(listener);
                    if (pos !== -1) listeners.splice(pos, 1);
                }
            },
            dispatchEvent: function (event) {
                var listener = this["on" + event.type];
                try {
                    if (listener && listener(event) === false) return false;
                } catch (err) {
                    console.error(err);
                }
                var listeners = this._el[event.type];
                if (listeners) {
                    for (var i = 0, l = listeners.length; i < l; ++i) {
                        listener = listeners[i];
                        try {
                            if ((listener.handleEvent || listener)(event) === false) return false;
                        } catch (err) {
                            console.error(err);
                        }
                    }
                }
                return true;
            }
        }
    });

    function IEGAPEvent(type) {
        var ev = document.createEvent('Event');
        ev.initEvent(type, true, true);
        var defaultPrevented = false,
            propagationStopped = false;

        Object.defineProperties(ev, {
            preventDefault: {
                value: function () {
                    defaultPrevented = true;
                }
            },
            defaultPrevented: {
                get: function () {
                    return defaultPrevented;
                }
            },
            stopPropagation: {
                value: function () {
                    propagationStopped = true;
                }
            },
            propagationStopped: {
                get: function () {
                    return propagationStopped;
                }
            },
            /*currentTarget: {
                get: function () {
                    return ev.target;
                }
            }*/
        });

        return ev;
    }

    //
    // IEGAP version of IDBRequest
    //
    function IEGAPRequest(source, transaction, execute) {
        this._el = {};
        this.source = source;
        this.transaction = transaction;
        this.readyState = "pending";
        var thiz = this;
        var eventTargetProp = { get: function () { return thiz; } };
        execute(function (e, result) {
            //if (e.type !== 'success') Object.defineProperty(e, "type", { value: "success" });
            thiz.result = result;
            Object.defineProperty(e, "target", eventTargetProp);
            thiz.readyState = "done";
            thiz.dispatchEvent(e);
        }, function (e, err) {
            //if (e.type !== 'error') Object.defineProperty(e, "type", { value: "error" });
            thiz.error = err || e.target.error;
            Object.defineProperty(e, "target", eventTargetProp);
            thiz.readyState = "done";
            if (e.type != "error") {
                Object.defineProperty(e, "type", { get: function() { return "error"; } });
            }
            thiz.dispatchEvent(e);
        }, this);
    }
    derive(IEGAPRequest).from(IEGAPEventTarget).extend({
        onsuccess: null,
        onerror: null,
    });

    //
    // IDBOpenRequest
    //
    function IEGAPOpenRequest(source, transaction, execute) {
        IEGAPRequest(source, transaction, execute);
    }
    derive(IEGAPOpenRequest).from(IEGAPRequest).extend({
        onblocked: null,
        onupgradeneeded: null
    });

    //
    // Blockable IDBRequest
    //
    function BlockableIDBRequest(source, store, execute) {
        /// <param name="store" type="IDBObjectStore"></param>
        var queue = store.transaction.$iegQue;
        if (!queue || queue.length == 0) return IEGAPRequest(source, store.transaction, execute);
        // Transaction is locked for writing. Put our request in queue:
        IEGAPRequest(source, store.transaction, function(resolve, reject, thiz) {
            queue.push(function() {
                execute(resolve, reject, thiz);
            });
        });
    }
    derive(BlockableIDBRequest).from(IEGAPRequest);

    //
    // whenUnblocked - execute callback when transaction is not blocked anymore.
    //
    function whenUnblocked(transaction, fn) {
        var queue = transaction.$iegQue;
        if (!queue || queue.length == 0)
            fn();
        else
            queue.push(fn);
    }

    function blockingManystepsOperation(transaction, reusableKeyGetter, fn) {
        var queue = transaction.$iegQue || (transaction.$iegQue = []);
        var lastItem = queue[queue.length - 1];
        if (queue.length === 0 || !reusableKeyGetter || !reusableKeyGetter() || lastItem.reusableKeyGetter() != reusableKeyGetter()) {
            // Put it on queue, unless the reusableKey is the same, and
            // the item has not yet started to execute (queue.length >= 2)
            // reusableKey will optimize the following scenario when createIndex()
            // was called several times after each other. Only one single reindexer
            // will have to execute:
            //   store.createIndex(...);
            //   store.createIndex(...);
            //   ...
            queue.push({
                execute: fn,
                reusableKeyGetter: reusableKeyGetter
            });
            if (queue.length === 1) executeQueue(transaction);
        }
    }

    //
    // BlockingManystepsRequest
    //
    function BlockingWriteRequest(operation) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="store" type="IDBObjectStore"></param>
        /// <param name="operation" value="{store: IDBObjectStore.prototype, op:'', args:[], resultMapper: function(){}}"></param>
        IEGAPRequest(operation.store, operation.store.transaction, function (success, error, request) {
            var store = operation.store,
                transaction = store.transaction,
                queue = transaction.$iegQue || (transaction.$iegQue = []),
                op = operation.op,
                implicitKey = op == 'delete' ? operation.args[0] : store.keyPath ? getByKeyPath(operation.args[0]) : operation.args[1],
                storeNameColonKey = implicitKey !== undefined && store.name + ":" + implicitKey; // If autoIncrement, implicitKey may be undefined

            extend(operation, {
                trigSuccess: success,
                trigError: error,
                req: request
            });
            // Clone the object according to IDB specification (put() and add() has object as first argument)
            if (op != 'delete') operation.args[0] = deepClone(operation.args[0]);

            var lastItem;
            if (queue.length <= 1 || (lastItem = queue[queue.length - 1], lastItem.execute) || (lastItem.keys.hasOwnProperty(storeNameColonKey))) {
                // If queue has one operation only, it is currently being executed so we cant extend it.
                // If queue has zero operations, there is nothing to extend (obviously)
                // If last item is a custom executor (has .execute), we can't extend it.
                // Else, we would be able to extend its last operation unless the last
                // operation already contained the same key as the the one we are adding. Reason: When our own
                // index-operations are executed in a bulk, we start by reading all existing values for all indexes
                // to see which indexes should be deleted and which should be added. That info would be invalid
                // the bulk contained multiple operations on the same key because the second operation would be
                // based on the state before the first operation's indexes has been executed.
                var queueItem = { ops: [operation], keys: {} };
                if (storeNameColonKey) queueItem.keys[storeNameColonKey] = true;
                queue.push(queueItem);
                if (queue.length == 1) executeQueue(store.transaction);
            } else {
                lastItem.ops.push(operation);
                if (storeNameColonKey) lastItem.keys[storeNameColonKey] = true;
            }
        });
    }
    derive(BlockingWriteRequest).from(IEGAPRequest);


    //
    // runNextOperationBulk - engine that handles read/write queue
    //
    function executeQueue(transaction) {
        /// <summary>
        ///   Simulates write-blocking queue.
        ///   If a IEGAPWriteRequest is ongoing on given transaction,
        ///   all other IEGAPReadRequests or IEGAPWriteRequests will be put
        ///   on a queue and executed sequencially for the current transaction.
        ///   Need this to guarantee data integrity for write operations 
        ///   that includes additional writes to virtual meta index stores.
        /// </summary>
        /// <param name="transaction" type="IDBTransaction"></param>
        var queue = transaction.$iegQue;
        if (!queue || queue.length === 0) return;
        var item = queue[0];
        while (typeof item == 'function') {
            // A reader found. Just call it, and the next, and the next... until empty or a "blocker" found.
            queue.shift();
            item();
            if (queue.length == 0) return;
            item = queue[0];
        }

        // A blocker found. Check if it is a custom 'execute' function or
        // if it contains a list of predefined operations (ops)
        if (item.execute) {
            // The operation is a javascript operation
            // Execute it and unqueue it when it's done:
            item.execute(function () {
                queue.shift();
                executeQueue(transaction);
            });
            return;
        }

        // The operation is a bulk of predefined operations ('add', 'put', or 'delete')
        var operations = item.ops;
        // 1. Extract index keys from put() and add() operations
        extractIndexKeys(operations);
        // 2. Execute the main operations in a bulk. Successs/Errors stored in each operation item.
        bulk(operations, function (successCount) {
            // 3. Get meta operations to execute:
            getMetaOperations(transaction, operations, function (metaOperations) {
                // 4. Execute all meta-operations:
                bulk(metaOperations, function () {
                    // 5. Trigger onsuccess / onerror for each finished operation
                    var transactionAborted = false;
                    var nRequests = 1;
                    operations.forEach(function (operation) {
                        /// <param name="operation" value="{result: '', error: null, indexKeys: [{ idxStoreName: '', key: '' }], store: IDBObjectStore.prototype, op:'delete/add/put', args:[], trigSuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}"></param>
                        if (transactionAborted) {
                            operation.trigError(new IEGAPEvent('error'), { name: "AbortError", message: "Transaction aborted" });
                        } else if (operation.error) {
                            var fakeEvent = new IEGAPEvent('error');
                            operation.trigError(fakeEvent, operation.error);
                            if (fakeEvent.defaultPrevented && fakeEvent.propagationStopped) return; // Just continue
                            // Trigger the error for real again and make sure to preventDefault() only
                            // if this fake event was defaultPrevented. Same for propagationStopped!
                            // If not defaultPrevented, transaction will cancel!
                            if (!fakeEvent.defaultPrevented)
                                transactionAborted = true;

                            ++nRequests;
                            // Redo the operation to trigger a fresh error
                            var replayedFailingRequest =
                                origObjectStorePrototype[operation.op].apply(operation.store, operation.args);

                            replayedFailingRequest.onerror = function(realEvent) {
                                if (fakeEvent.defaultPrevented) realEvent.preventDefault();
                                if (fakeEvent.propagationStopped) realEvent.stopPropagation();
                                checkComplete();
                            }
                            replayedFailingRequest.onsuccess = function(realEvent) {
                                console.error("Request didnt fail when replayed! Oops! Fatal! Make sure transaction is aborted then...");
                                transaction.abort();
                                transactionAborted = true;
                                checkComplete();
                            }
                        } else {
                            operation.trigSuccess(new IEGAPEvent('success'), operation.result);
                        }
                    });
                    checkComplete();

                    function checkComplete() {
                        if (--nRequests === 0) {
                            queue.shift();
                            executeQueue(transaction);
                        }
                    }
                });
            });
        });
    }

    function extractIndexKeys(operations) {
        /// <param name="operations" value="[{store: IDBObjectStore.prototype, op:'delete/add/put', args:[], onsuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}]"></param>        
        operations.forEach(function(operation) {
            if (operation.op === 'add' || operation.op === 'put') {
                var object = operation.args[0],
                    store = operation.store,
                    meta = getMeta(store),
                    indexKeys = (operation.indexKeys = []);
                var indexes = Object.keys(meta.indexes)
                    .map(function(name) { return meta.indexes[name]; });

                indexes.forEach(function(indexSpec) {
                    var idxKeys = getByKeyPath(object, indexSpec.keyPath),
                        idxStoreName = indexSpec.idxStoreName;
                    if (idxKeys !== undefined && idxKeys !== null) {
                        if (indexSpec.multiEntry) {
                            if (Array.isArray(idxKeys)) {
                                // the result of evaluating the index's key path yields an Array
                                idxKeys.forEach(function(idxKey) {
                                    indexKeys.push({ idxStoreName: idxStoreName, key: idxKey });
                                });
                            } else {
                                // the result of evaluating the index's key path doesn't yield an Array
                                indexKeys.push({ idxStoreName: idxStoreName, key: idxKeys });
                            }
                        } else if (indexSpec.compound) {
                            if (idxKeys) {
                                var stringifiedKey = compoundToString(idxKeys);
                                indexKeys.push({ idxStoreName: idxStoreName, key: stringifiedKey });
                            }
                        } else {
                            throw "IEGap assert error";
                        }
                    }
                });
            }
        });
    }

    function getMetaOperations(transaction, operations, cb) {
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="operations" value="[{result: '', error: null, indexKeys: [{ idxStoreName: '', key: '' }], store: IDBObjectStore.prototype, op:'delete/add/put', args:[], onsuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}]"></param>
        var nRequests = 1,
            metaOperations = [];
        operations.forEach(function (operation) {
            if (operation.error) return; // dont execute meta operation if main operation failed
            var op = operation.op;
            var meta = getMeta(operation.store);
            var indexes = Object.keys(meta.indexes)
                .map(function(name) {
                    return meta.indexes[name];
                });
            if (op === 'add') {
                // TODO: map indexKeys to metaOperations
            } else if (op == 'put') {
                // TODO: Read existing meta-indexes, diff with indexKeys and map to metaOperations
            } else if (op == 'delete') {
                // TODO: Read all existing meta-indexes to delete and map to delete()-metaOperations.
            } else {
                var msg = "IEGAP assert failure - bad operation: " + operation.op;
                console.error(msg);
                throw msg;
            }
        });
        checkComplete();

        function checkComplete() {
            if (--nRequests === 0) cb(metaOperations);
        }
    }

    //
    // Our IDBKeyRange
    //

    function IEGAPKeyRange(lower, upper, lowerOpen, upperOpen) {
        this.lower = lower;
        this.upper = upper;
        this.lowerOpen = lowerOpen;
        this.upperOpen = upperOpen;
    }

    //
    // Our DOMStringList
    //

    function IEGAPStringList(a) {
        Object.defineProperties(a, {
            contains: {
                configurable: true, writable: true, value: function (str) {
                    return a.indexOf(str) !== -1;
                }
            },
            item: {
                configurable: true, writable: true, value: function (index) {
                    return a[index];
                }
            }
        });
        return a;
    }

    function Constructor() {

        var getObjectStoreNames = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "objectStoreNames").get;
        //var getIndexNames = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "indexNames").get;
        var deleteObjectStore = IDBDatabase.prototype.deleteObjectStore;
        var createObjectStore = IDBDatabase.prototype.createObjectStore;


        initPowTable();

        //
        // Inject into onupgradeneeded and onsuccess in indexedDB.open()
        //
        idb.open = override(idb.open, function(orig) {
            return function (name, version) {
                var req = orig.apply(this, arguments);
                return new IEGAPOpenRequest(this, null, function (success, error, iegReq) {
                    req.onerror = error;
                    req.onblocked = function(ev) { iegReq.dispatchEvent(ev); };
                    req.onupgradeneeded = function (ev) {
                        iegReq.transaction = req.transaction;
                        var db = (iegReq.result = req.result);
                        db._upgradeTransaction = req.transaction; // Needed in IDBDatabase.prototype.deleteObjectStore(). Save to set like this because during upgrade transaction, no other transactions may live concurrently.
                        db._iegapmeta = { stores: {} };
                        if (!getObjectStoreNames.apply(db).contains("$iegapmeta")) {
                            var store = createObjectStore.call(db, "$iegapmeta");
                            store.add(db._iegapmeta, 1);
                        }
                        ev.target = ev.currentTarget = iegReq;
                        iegReq.dispatchEvent(ev);
                    }
                    req.onsuccess = function(ev) {
                        var db = req.result;
                        delete db._upgradeTransaction;
                        db._iegapmeta = { stores: {} }; // Until we have loaded the correct value, we need db.transaction() to work.
                        try {
                            var trans = db.transaction(["$iegapmeta"], 'readonly');
                            var req2 = trans.objectStore("$iegapmeta").get(1);
                            req2.onerror = error;
                            req2.onsuccess = function() {
                                db._iegapmeta = req2.result;
                                success(ev, db);
                            }
                        } catch (e) {
                            error(ev, e);
                        }
                    }
                });
            }
        });

        //
        // Inject into window.IDBKeyRange
        //

        IDBKeyRange.bound = override(IDBKeyRange.bound, function(orig) {
            return function bound(lower, upper, lopen, oopen) {
                if (!Array.isArray(lower)) return orig.apply(this, arguments);
                return new IEGAPKeyRange(lower, upper, lopen, oopen);
            }
        });

        IDBKeyRange.lowerBound = override(IDBKeyRange.lowerBound, function(orig) {
            return function lowerBound(bound, open) {
                if (!Array.isArray(bound)) return orig.apply(this, arguments);
                return new IEGAPKeyRange(bound, null, open, null);
            }
        });

        IDBKeyRange.upperBound = override(IDBKeyRange.upperBound, function(orig) {
            return function upperBound(bound, open) {
                if (!Array.isArray(bound)) return orig.apply(this, arguments);
                return new IEGAPKeyRange(null, bound, null, open);
            }
        });

        IDBKeyRange.only = override(IDBKeyRange.only, function(orig) {
            return function only(val) {
                if (!Array.isArray(val)) return orig.apply(this, arguments);
                return new IEGAPKeyRange(val, val);
            }
        });

        //
        // Inject into window.IDBObjectStore
        //
        IDBObjectStore.prototype.count = override(IDBObjectStore.prototype.count, function(orig) {
            return function (key) {
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (arguments.length > 0) arguments[0] = parseKeyParam(key);
                if (!meta || meta.metaStores.length == 0) return orig.apply(this, arguments);
                // If comes here, the store has metaStores containing polyfilled indexes.
                // If so, the transaction may be locked for writing and we must therefore
                // use BlockableIDBRequest to defer the operation if it is.
                var thiz = this,
                    args = arguments;
                return new BlockableIDBRequest(this, this, function(success, error) {
                    var req = orig.apply(thiz, args);
                    req.onsuccess = success;
                    req.onerror = error;
                });
            }
        });

        IDBObjectStore.prototype.get = override(IDBObjectStore.prototype.get, function(orig) {
            return function (key) {
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (arguments.length > 0) arguments[0] = parseKeyParam(key);
                if (!meta || meta.metaStores.length == 0) return orig.apply(this, arguments);
                // If comes here, the store has metaStores containing polyfilled indexes.
                // If so, the transaction may be locked for writing and we must therefore
                // use BlockableIDBRequest to defer the operation if it is.
                var thiz = this,
                    args = arguments;
                return new BlockableIDBRequest(this, this, function (success, error) {
                    var req = orig.apply(thiz, args);
                    req.onsuccess = success;
                    req.onerror = error;
                });
            }
        });

        IDBObjectStore.prototype.openCursor = override(IDBObjectStore.prototype.openCursor, function(orig) {
            return function (range, dir) {
                /// <param name="range" type="IDBKeyRange"></param>
                /// <param name="dir" type="String"></param>
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (!meta) return orig.apply(this, arguments);
                if (Array.isArray(range)) range = new IEGAPKeyRange(range, range);
                var compound = meta.compound;
                if (compound && range && !(range instanceof IEGAPKeyRange)) throw new RangeError("Primary key is compound but given range is not.");
                var idbRange = compound && range ?
                    IDBKeyRange.bound(compoundToString(range.lower), compoundToString(range.upper), range.lowerOpen, range.upperOpen) :
                    range;
                arguments[0] = idbRange;
                var req = orig.apply(this, arguments);
                var store = this;
                return new BlockableIDBRequest(this, this, function(success, error) {
                    req.onerror = error;
                    req.onsuccess = function (ev) {
                        var cursor = ev.target.result;
                        if (cursor) {
                            var key = compound ? stringToCompound(cursor.key) : cursor.key;
                            var iegapCursor = new IEGAPCursor(cursor, store, store, key, key, cursor.value);
                            success(ev, iegapCursor);
                        } else {
                            success(ev, null);
                        }
                    }
                });
            }
        });

        IDBObjectStore.prototype.createIndex = override(IDBObjectStore.prototype.createIndex, function (origFunc) {

            function createIndex(store, name, keyPath, props) {
                /// <summary>
                /// 
                /// </summary>
                /// <param name="store" type="IDBObjectStore"></param>
                /// <param name="name"></param>
                /// <param name="keyPath"></param>
                /// <param name="props" value="{unique: true, multiEntry: true}"></param>
                var db = store.transaction.db;
                var idxStoreName = "$iegap-" + store.name + "-" + name;
                var meta = db._iegapmeta;
                if (props.multiEntry && Array.isArray(keyPath)) {
                    // IDB spec require us to throw DOMException.INVALID_ACCESS_ERR
                    createObjectStore.call(db, "dummy", { keyPath: "", autoIncrement: true }); // Will throw DOMException.INVALID_ACCESS_ERR
                    throw "invalid access"; // fallback.
                }
                var idxStore = createObjectStore.call(db, idxStoreName, { autoIncrement: true });

                var storeMeta = meta.stores[store.name] || (meta.stores[store.name] = {indexes: {}, metaStores: [] });
                var indexMeta = {
                    name: name,
                    keyPath: keyPath,
                    multiEntry: props.multiEntry || false,
                    unique: props.unique || false,
                    compound: Array.isArray(keyPath),
                    storeName: store.name,
                    idxStoreName: idxStoreName
                };
                storeMeta.indexes[name] = indexMeta;
                storeMeta.metaStores.push(idxStoreName);
                idxStore.createIndex("fk", "fk", { unique: false });
                var keyIndex = idxStore.createIndex("k", "k", { unique: props.unique || false });
                setMeta(db, store.transaction, meta);

                // Reindexing existing data:
                var reusableKey = store.name;
                blockingManystepsOperation(store.transaction, function () { return reusableKey; }, function (done) {
                    // TODO: Don't put()! It will cause an infinite wait since we are holding the lock!
                    // Instead, use generateIndexRecords(obj, indexMeta, outOperations)
                    var currentBulk = [];
                    store.openCursor().onsuccess = function (ev) {
                        reusableKey = null; // At this point, a new reindexer must not reuse us anymore!
                        var cursor = ev.target.result;
                        if (cursor) {
                            currentBulk.push(cursor.value);
                            if (currentBulk.length === 1000) {
                                reindex(currentBulk, false);
                                currentBulk = [];
                            }
                            cursor.continue();
                        } else {
                            reindex(currentBulk, true);
                        }
                    }
                    function reindex(objectsToReindex, isLastBulk) {
                        var lastReq = null;
                        objectsToReindex.forEach(function (obj) {
                            lastReq = store.put(obj); // Will call our version of 'put', which will index correctly.
                            lastReq.onerror = ignore("reindex existing object");
                        });
                        if (isLastBulk) {
                            if (!lastReq) done();
                            else {
                                lastReq.onerror = ignore("reindex the last object", done);
                                lastReq.onsuccess = done;
                            }
                        }
                    }
                });

                if (!store._reindexing) {
                    store._reindexing = true;
                    store.openCursor().onsuccess = function (e) {
                        delete store._reindexing;
                        var cursor = e.target.result;
                        if (cursor) {
                            cursor.update(cursor.value); // Will call out version of IDBObjectStore.put() that will re-index all items!
                            cursor.continue();
                        }
                    }
                }
                return new IEGAPIndex(keyIndex, store, name, keyPath, props.multiEntry);
            }

            return function (name, keyPath, props) {
                if (Array.isArray(keyPath) || (props && props.multiEntry))
                    return createIndex(this, name, keyPath, props || {});
                return origFunc.apply(this, arguments);
            }
        });

        IDBObjectStore.prototype.deleteIndex = override(IDBObjectStore.prototype.deleteIndex, function(origFunc) {
            return function(name) {
                var db = this.transaction.db;
                var meta = db._iegapmeta;
                var storeMeta = meta.stores[this.name];
                if (!storeMeta) return origFunc.apply(this, arguments);
                var indexMeta = storeMeta.indexes[name];
                if (!indexMeta) return origFunc.apply(this, arguments);
                deleteObjectStore.call(db, indexMeta.idxStoreName);
                delete storeMeta.indexes[name];
                setMeta(db, this.transaction, meta);
            }
        });

        IDBObjectStore.prototype.index = override(IDBObjectStore.prototype.index, function(origFunc) {

            return function (indexName) {
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (!meta) return origFunc.apply(this, arguments);
                var idx = meta.indexes[indexName];
                return idx ?
                    new IEGAPIndex(this.transaction.objectStore(idx.idxStoreName).index("k"), this, idx.name, idx.keyPath, idx.multiEntry) :
                    origFunc.apply(this, arguments);
            };
        });
        
        // TODO: Check if this is finished in its implementation. May probably be!
        IDBObjectStore.prototype.add = override(IDBObjectStore.prototype.add, function (origFunc) {
            return function(value, key) {
                var meta = getMeta(this);
                if (!meta) return origFunc.apply(this, arguments);
                if (meta.compound) {
                    // Compound primary key
                    // Key must not be provided when having inbound keys (compound is inbound)
                    if (key) return this.add(null); // Trigger DOMException(DataError)!
                    key = compoundToString(getByKeyPath(value, meta.keyPath));
                    return new BlockingWriteRequest({
                        store: this,
                        op: 'add',
                        args: [value, key],
                        resultMapper: function (r) { return stringToCompound(r); } // TODO: Execute resultsMapper somewhere!
                    });
                    //addReq = origFunc.call(this, value, key);
                }
                var indexes = Object.keys(meta.indexes);
                if (!meta.compound && indexes.length === 0) return origFunc.apply(this, arguments); // No indexes to deal with
                return new BlockingWriteRequest({
                    store: this,
                    op: 'add',
                    args: arguments
                });
                var store = this;
                return new IEGAPRequest(this, this.transaction, function(success, error) {
                    var addEvent = null, errorEvent = null, indexAddFinished = false, rollbacks = [];
                    var primKey = key || (store.keyPath && getByKeyPath(value, store.keyPath));
                    if (!primKey) {
                        addReq.onerror = error;
                        addReq.onsuccess = function(ev) {
                            addEvent = ev;
                            primKey = addReq.result;
                            addIndexKeys();
                        }
                    } else {
                        // Caller provided primKey - we can start adding indexes at once! No need waiting for onsuccess. However, this means we may need to rollback our stuff...
                        // So, why do it in such a complex way? Because otherwise we fail on a W3C web-platform-test where an item is added and then expected its index to be there the line after.
                        addIndexKeys();
                        addReq.onerror = function(ev) {
                            errorEvent = ev;
                            ev.preventDefault(); // Dont abort transaction quite yet. First roll-back our added indexes, then when done, call the real error eventhandler and check if it wants to preventDefault or not.
                            checkFinally();
                        }
                        addReq.onsuccess = function(ev) {
                            addEvent = ev;
                            checkFinally();
                        }
                    }

                    function checkFinally() {
                        if (indexAddFinished && (addEvent || errorEvent))
                            if (errorEvent) {
                                var defaultPrevented = false;
                                errorEvent.preventDefault = function () { defaultPrevented = true; };
                                error(errorEvent);
                                if (!defaultPrevented) store.transaction.abort(); // We prevented default in the first place. Now we must manually abort when having called the event handler
                            } else
                                success(addEvent, meta.compound ? stringToCompound(addReq.result) : addReq.result);
                    }

                    function addIndexKeys() {
                        var nRequests = indexes.length;
                        indexes.forEach(function (indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            if (indexSpec.multiEntry) {
                                addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, rollbacks, checkComplete);
                            } else if (indexSpec.compound) {
                                addCompoundIndexKey(idxStore, indexSpec, value, primKey, rollbacks, checkComplete);
                            } else {
                                throw "IEGap assert error";
                            }
                        });

                        function checkComplete() {
                            if (--nRequests === 0) {
                                if (!errorEvent) {
                                    indexAddFinished = true;
                                    checkFinally();
                                } else {
                                    bulk(rollbacks, function() {
                                        indexAddFinished = true;
                                        checkFinally();
                                    }, "rolling back index additions");
                                }
                            }
                        }
                    }
                });
            }
        });

        // TODO: Rewrite this:
        IDBObjectStore.prototype.put = override(IDBObjectStore.prototype.put, function (origFunc) {
            return function (value, key) {
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (!meta) return origFunc.apply(this, arguments);
                var putReq;
                if (meta.compound) {
                    // Compound primary key
                    // Key must not be provided when having inbound keys (compound is inbound)
                    if (key) return this.add(null); // Trigger DOMException(DataError)!
                    key = compoundToString(getByKeyPath(value, meta.keyPath));
                    putReq = origFunc.call(this, value, key);
                } else {
                    putReq = origFunc.apply(this, arguments);
                }
                var indexes = Object.keys(meta.indexes);
                if (!meta.compound && indexes.length === 0) return putReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function (success, error) {
                    var putEvent = null;
                    var primKey;
                    putReq.onerror = error;
                    putReq.onsuccess = function (ev) {
                        putEvent = ev;
                        primKey = putReq.result;
                        replaceIndexKeys();
                    }

                    function replaceIndexKeys() {
                        var nRequests = indexes.length;
                        indexes.forEach(function(indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            bulkDelete(idxStore.index("fk"), primKey, function () {
                                // then, when deleted, add entries:
                                if (indexSpec.multiEntry) {
                                    addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, null, checkComplete);
                                } else if (indexSpec.compound) {
                                    addCompoundIndexKey(idxStore, indexSpec, value, primKey, null, checkComplete);
                                } else {
                                    checkComplete();
                                    throw "IEGap assert error";
                                }
                            });
                        });

                        function checkComplete() {
                            if (--nRequests === 0) success(putEvent, meta.compound ? stringToCompound(primKey) : primKey);
                        }
                    }
                });
            }
        });

        // TODO: Rewrite this!
        IDBObjectStore.prototype.delete = override(IDBObjectStore.prototype.delete, function (origFunc) {
            return function (key) {
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (!meta) return origFunc.apply(this, arguments);
                if (meta.compound) {
                    // Compound primary key
                    key = compoundToString(key);
                }
                var delReq = origFunc.call(this, key);
                var indexes = Object.keys(meta.indexes);
                if (indexes.length == 0) return delReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function (success, error) {
                    var delEvent = null;
                    delReq.onerror = error;
                    delReq.onsuccess = function(ev) {
                        delEvent = ev;
                        deleteIndexKeys();
                    }

                    function deleteIndexKeys() {
                        var nRequests = indexes.length;
                        indexes.forEach(function (indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            bulkDelete(idxStore.index("fk"), key, checkComplete);
                        });

                        function checkComplete() {
                            if (--nRequests === 0) success(delEvent);
                        }
                    }
                });
            }
        });

        IDBObjectStore.prototype.clear = override(IDBObjectStore.prototype.clear, function(origFunc) {
            return function() {
                // TODO: Förenkla denna!
                // Returnera ett BlockableIDBRequest() som i sin execute gör:
                // 1. cleara alla meta-stores
                // 2. cleara object store och sätt onsuccess = success, onerror = error.
                var clearReq = origFunc.apply(this, arguments);
                var meta = this.transaction.db._iegapmeta.stores[this.name];
                if (!meta) return clearReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function(success, error) {
                    var indexes = Object.keys(meta.indexes);
                    var clearEvent = null;
                    clearReq.onerror = error;
                    clearReq.onsuccess = function(ev) {
                        clearEvent = ev;
                        clearIndexStores();
                    }

                    function clearIndexStores() {
                        var nRequests = indexes.length;
                        if (nRequests === 0) return success(clearEvent);
                        indexes.forEach(function (indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            var idxClearReq = idxStore.clear();
                            idxClearReq.onerror = ignore("clearing meta store", checkComplete);
                            idxClearReq.onsuccess = checkComplete;
                        });

                        function checkComplete() {
                            if (--nRequests === 0) success(clearEvent);
                        }
                    }
                });
            }
        });

        override(IDBObjectStore.prototype, {
            indexNames: function (origPropDescriptor) {
                return {
                    get: function() {
                        var rv = [].slice.call(origPropDescriptor.get.apply(this));
                        var meta = this.transaction.db._iegapmeta.stores[this.name];
                        if (meta) rv = rv.concat(Object.keys(meta.indexes));
                        return new IEGAPStringList(rv);
                    }
                }
            },
            autoIncrement: function(orig) {
                return {
                    get: function() {
                        var meta = this.transaction.db._iegapmeta.stores[this.name];
                        return meta && 'autoIncrement' in meta ? meta.autoIncrement : orig.get.call(this);
                    }
                }
            },
            keyPath: function(orig) {
                return {
                    get: function () {
                        var meta = this.transaction.db._iegapmeta.stores[this.name];
                        return meta && 'keyPath' in meta ? meta.keyPath : orig.get.call(this);
                    }
                }
            }
        });

        //
        // Inject into window.IDBDatabase
        //
        override(IDBDatabase.prototype, {
            transaction: function(origPropDescriptor) {
                return {
                    value: function(storeNames, mode) {
                        storeNames = typeof storeNames == 'string' ? [storeNames] : [].slice.call(storeNames);
                        var storesWithMeta = this._iegapmeta.stores;
                        storeNames.forEach(function (name) {
                            var meta = storesWithMeta[name];
                            if (meta) storeNames = storeNames.concat(meta.metaStores);
                        });
                        return origPropDescriptor.value.call(this, storeNames, mode || "readonly");
                    }
                };
            },
            objectStoreNames: function(origPropDescriptor) {
                return {
                    get: function() {
                        return new IEGAPStringList([].slice.call(origPropDescriptor.get.apply(this)).filter(
                            function(storeName) {
                                return storeName.indexOf('$iegap') !== 0;
                            }
                        ));
                    }
                }
            },
            createObjectStore: function(origPropDescriptor) {
                return {
                    value: function (storeName, props) {
                        /// <summary>
                        ///   Hook into when object stores are create so that we
                        ///   may support compound primary keys.
                        /// </summary>
                        /// <param name="storeName" type="String"></param>
                        /// <param name="props" optional="true" value="{keyPath: [], autoIncrement: false}"></param>
                        /// <returns type="IDBObjectStore"></returns>
                        var rv, compound = false;
                        if (!props || !Array.isArray(props.keyPath)) {
                            rv = origPropDescriptor.value.apply(this, arguments);
                        } else {
                            compound = true;
                            if (props.autoIncrement) throw new RangeError("Cannot autoincrement compound key");
                            // Caller provided an array as keyPath. Need to polyfill:
                            // Create the ObjectStore without inbound keyPath:
                            rv = origPropDescriptor.value.call(this, storeName);
                        }
                        // Then, store the keyPath array in our meta-data:
                        var meta = this._iegapmeta;
                        var storeMeta = meta.stores[storeName] || (meta.stores[storeName] = { indexes: {}, metaStores: [] });
                        storeMeta.keyPath = (props && props.keyPath) || null;
                        storeMeta.compound = compound;
                        storeMeta.autoIncrement = (props && props.autoIncrement) || false;
                        setMeta(this, rv.transaction, meta);
                        return rv;
                    }
                }
            },
            deleteObjectStore: function (origPropDescriptor) {
                return {
                    value: function (storeName) {
                        origPropDescriptor.value.call(this, storeName);
                        var meta = this._iegapmeta;
                        var storeMeta = meta.stores[storeName];
                        if (!storeMeta) return;
                        storeMeta.metaStores.forEach(function(metaStoreName) {
                            origPropDescriptor.value.call(this, metaStoreName);
                        });
                        delete meta.stores[storeName];
                        if (!this._upgradeTransaction) throw "assert error"; // In case we're not in upgrade phase, first call to origPropDescriptor.value.call(storeName) would can thrown already.
                        setMeta(this, this._upgradeTransaction, meta);
                    }
                }
            }
        });
    }

    function IIndexMeta() {
        return {
            name: '',
            keyPath: '', // string or array of strings
            multiEntry: false,
            unique: false,
            compound: false,
            storeName: '',
            idxStoreName: ''
        };
    }

    function IStoreMeta() {
        return {
            metaStores: [''],
            indexes: { indexName: new IIndexMeta() }, // map<indexName,IIndexMeta>
            compound: false,
            keyPath: ['a', 'b.c'] // string or array of strings
        };
    }

    function IOperation() {
        return {
            store: IDBObjectStore.prototype,
            op: 'delete / add / get / put',
            args: [],
            result: null,
            error: null
        };
    }

    Constructor();
})(window.indexedDB || window.msIndexedDB);
