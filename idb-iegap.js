if (navigator.userAgent.indexOf("Trident/") !== -1)
(function(idb, undefined) {
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
            Object.keys(overrider).forEach(function(prop) {
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
                    if (value === undefined) delete obj[currentKeyPath];
                    else obj[currentKeyPath] = value;
                else {
                    var innerObj = obj[currentKeyPath];
                    if (!innerObj) innerObj = (obj[currentKeyPath] = {});
                    setByKeyPath(innerObj, remainingKeyPath, value);
                }
            } else {
                if (value === undefined) delete obj[keyPath];
                else obj[keyPath] = value;
            }
        }
    }

    function delByKeyPath(obj, keyPath) {
        setByKeyPath(obj, keyPath, undefined);
    }

    function deepClone(any) {
        if (!any || typeof any !== 'object') return any;
        var rv;
        if (Array.isArray(any) || any instanceof DOMStringList) {
            rv = [];
            for (var i = 0, l = any.length; i < l; ++i) {
                rv.push(deepClone(any[i]));
            }
        } else if (any instanceof Date) {
            rv = new Date();
            rv.setTime(any.getTime());
        } else { // TODO: Clone Blobs and other special types?
            rv = any.constructor ? Object.create(any.constructor.prototype) : {};
            for (var prop in any) {
                if (any.hasOwnProperty(prop)) {
                    rv[prop] = deepClone(any[prop]);
                }
            }
        }
        return rv;
    }

    function fail(op, cb, bIgnore, bFatal) {
        return function(ev) {
            var msg = op && (bFatal ? "Fatal" : "Warning") + ": IEGap polyfill failed to " + (op.call ? op() : op) + ": " + ev.target.error;
            if (op) console.error(msg);
            if (bIgnore) {
                ev.stopPropagation();
                ev.preventDefault();
            }
            if (cb)
                cb(ev);
            else if (!bIgnore)
                throw new Error(msg);
        }
    }

    function fatal(op) {
        return fail(op, null, false, true);
    }

    function ignore(op, cb) {
        return fail(op, cb, true);
    }

    //
    // Constants and imports
    //
    var POWTABLE = {};
    var IDBKeyRange = window.IDBKeyRange,
        IDBObjectStore = window.IDBObjectStore,
        IDBDatabase = window.IDBDatabase,
        IDBIndex = window.IDBIndex;

    var STORENAME_META = "$iegapmeta",
        STORENAME_AUTOINC = "$iegapAutoIncs";

    var OrigProtos = {
        DB: {
            objectStoreNames: Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "objectStoreNames"),
            deleteObjectStore: IDBDatabase.prototype.deleteObjectStore,
            createObjectStore: IDBDatabase.prototype.createObjectStore
        },
        ObjectStore: {
            add: IDBObjectStore.prototype.add,
            put: IDBObjectStore.prototype.put,
            'delete': IDBObjectStore.prototype.delete,
            get: IDBObjectStore.prototype.get,
            count: IDBObjectStore.prototype.count,
            openCursor: IDBObjectStore.prototype.openCursor,
            index: IDBObjectStore.prototype.index,
        },
        Index: {
            openCursor: IDBIndex.prototype.openCursor
        }
    }

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

    // According to IDB Spec 3.1.3 Keys, the following types must be compared in the right order:
    var KEY_TYPE_ARRAY = "z",
        KEY_TYPE_STRING = "s",
        KEY_TYPE_DATE = "d",
        KEY_TYPE_INFINITY = "Z",
        KEY_TYPE_POSNUMBER = "P",
        KEY_TYPE_NEGNUMBER = "N",
        KEY_TYPE_NEGINFINITY = "0";

    function compoundToString(a, parents) {
        /// <param name="a" type="Array"></param>
        if (!a || !Array.isArray(a)) return null;
        var l = a.length,
            rv = new Array(l);
        for (var i = 0; i < l; ++i) {
            var part = a[i];
            if (typeof part === 'string')
                rv[i] = KEY_TYPE_STRING + part;
            else if (typeof part === 'number') {
                if (isNaN(part)) return null;
                if (part === -Infinity) rv[i] = KEY_TYPE_NEGINFINITY;
                else if (part === Infinity) rv[i] = KEY_TYPE_INFINITY;
                else rv[i] = (part < 0 ? KEY_TYPE_NEGNUMBER : KEY_TYPE_POSNUMBER) + unipack(part, 5, 4);
            } else if (part instanceof Date)
                rv[i] = KEY_TYPE_DATE + unipack(part.getTime(), 4, 0);
            else if (Array.isArray(part)) {
                if (part === a || (parents && parents.indexOf(part) !== -1)) return null; // Accoriding to IDB Spec 3.1.3 Keys
                var subArray = compoundToString(part, parents ? parents.concat(a) : [a]);
                if (!subArray) return null; // Accoriding to IDB Spec 3.1.3 Keys
                rv[i] = KEY_TYPE_ARRAY + subArray;
            } else
                return null; // No supported type
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
            if (type === KEY_TYPE_STRING)
                value = encoded;
            else if (type === KEY_TYPE_POSNUMBER)
                value = uniback(encoded, 5, 4, false);
            else if (type === KEY_TYPE_NEGNUMBER)
                value = uniback(encoded, 5, 4, true);
            else if (type === KEY_TYPE_DATE)
                value = new Date(uniback(encoded, 4, 0));
            else if (type === KEY_TYPE_INFINITY)
                value = Infinity;
            else if (type === KEY_TYPE_NEGINFINITY)
                value = -Infinity;
            else if (type === KEY_TYPE_ARRAY)
                value = stringToCompound(encoded);
            rv[i] = value;
        }
        return rv;
    }

    function isValidKey(key, parents) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="key"></param>
        /// <param name="parents" optional="true" type="Array" elementType="Array">
        /// If key is contained by an parent array key, supply an array
        /// containing the parent array and its parents</param>
        /// <returns type=""></returns>
        return (
            typeof (key) === 'string' ||
            (typeof (key) === 'number' && !isNaN(key)) ||
            (key instanceof Date && !isNaN(key.getTime())) ||
            (Array.isArray(key) && isValidArrayKey(key, parents || []))
        );
    }

    function isValidArrayKey(a, parents) {
        /// <param name="a" type="Array"></param>
        /// <param name="parents" type="Array" elementType="Array"></param>
        var parentsAndSelf = parents ? parents.concat(a) : [a];
        return a.every(function(key) {
            if (key === a || (parents && parents.indexOf(key) !== -1)) return false; // Accoriding to IDB Spec 3.1.3 Keys
            return isValidKey(key, parents ? parents.concat(a) : [a]);
        });
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

    function bulk(operations, options, cb) {
        /// <summary>
        ///     Execute given array of operations and the call given callback
        /// </summary>
        /// <param name="operations" type="Array" elementType="IOperation">Operations to execute</param>
        /// <param name="cb" value="function(successCount){}"></param>
        if (arguments.length < 3) {
            cb = arguments[1];
            options = {swallowErrors: true};
        }
        var nRequests = operations.length,
            successCount = 0,
            swallowErrors = options.swallowErrors === true,
            onerror = options.onerror,
            onsuccess = options.onsuccess;

        if (nRequests === 0) {
            if (cb) cb();
            return;
        }

        operations.forEach(function(item) {
            var req = OrigProtos.ObjectStore[item.op].apply(item.store, item.args);
            req.onsuccess = function(ev) {
                item.result = ev.target.result;
                ++successCount;
                if (onsuccess) onsuccess(ev, item);
                checkComplete();
            }
            req.onerror = function (ev) {
                item.error = ev.target.error;
                if (swallowErrors) {
                    ev.stopPropagation();
                    ev.preventDefault();
                } else if (onerror) onerror(ev, item);
                checkComplete();
            }
        });

        function checkComplete() {
            if (--nRequests === 0 && cb) cb(successCount);
        }
    }

    function generateIndexingOperations(transaction, obj, primKey, indexMeta, outOperations, mainOperation) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="obj" type="Object">Object to index</param>
        /// <param name="primKey" type="String">Primary key of the object.</param>
        /// <param name="indexMeta" type="IIndexMeta">Index specification of the index type</param>
        /// <param name="outOperations" type="Array" elementType="IOperation">out: Operations that would do the job</param>
        if (Array.isArray(primKey)) primKey = compoundToString(primKey);
        var idxKeys = getByKeyPath(obj, indexMeta.keyPath);
        if (idxKeys === undefined) return;
        var idxStore = transaction.objectStore(indexMeta.idxStoreName);
        var idx, idxPrimKey;
        if (indexMeta.compound) {
            var key = compoundToString(idxKeys);
            if (key) {
                idx = { fk: primKey, k: key };
                idxPrimKey = compoundToString([primKey, key]);
                outOperations.push({ store: idxStore, op: "add", args: [idx, idxPrimKey], mainOp: mainOperation });
            }
        } else if (indexMeta.multiEntry) {
            if (!Array.isArray(idxKeys)) {
                if (isValidKey(idxKeys)) {
                    idx = { fk: primKey, k: idxKeys };
                    idxPrimKey = compoundToString([idx.fk, idx.k]);
                    outOperations.push({ store: idxStore, op: "add", args: [idx, idxPrimKey], mainOp: mainOperation });
                }
            } else {
                var addedKeys = {};
                idxKeys.forEach(function(idxKey) {
                    if (isValidKey(idxKey)) {
                        idx = { fk: primKey, k: idxKey };
                        idxPrimKey = compoundToString([idx.fk, idx.k]);
                        if (!addedKeys.hasOwnProperty(idxKey)) { // Never add the same key twice
                            outOperations.push({ store: idxStore, op: "add", args: [idx, idxPrimKey], mainOp: mainOperation });
                            addedKeys[idxKey] = true;
                        }
                    }
                });
            }
        }
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
            return new BlockableIDBRequest(iegIndex, iegIndex.objectStore, function(success, error) {
                var compound = iegIndex._compound,
                    compoundPrimKey = Array.isArray(iegIndex.objectStore.keyPath);
                if (compound && Array.isArray(range)) range = new IEGAPKeyRange(range, range);
                var idbRange = compound && range ?
                    IDBKeyRange.bound(compoundToString(range.lower), compoundToString(range.upper), range.lowerOpen, range.upperOpen) :
                    range;

                if (typeof idbRange === 'undefined') idbRange = null;
                var req = OrigProtos.Index.openCursor.call(iegIndex._idx, idbRange, dir);
                req.onerror = error;
                if (includeValue) {
                    req.onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        if (cursor) {
                            var getreq = iegIndex._store.get(cursor.value.fk);
                            getreq.onerror = error;
                            getreq.onsuccess = function() {
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
            count: function(key) {
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
                return new BlockableIDBRequest(this, this.objectStore, function(success, error) {
                    var req = thiz._idx.get(parseKeyParam(key));
                    // First request the meta-store for this index
                    req.onsuccess = function(ev) {
                        // Check if key was found. 
                        var foreignKey = req.result && req.result.fk;
                        if (foreignKey) {
                            // Key found. Do a new request on the origin store based on the foreignKey found in meta-store.
                            req = thiz.objectStore.get(foreignKey);
                            req.onsuccess = function() {
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
                return new BlockableIDBRequest(this, this.objectStore, function(success, error) {
                    var req = thiz._idx.get(parseKeyParam(key));
                    req.onsuccess = function(ev) {
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
            advance: function(n) {
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
            "delete": function() {
                // lock not needed. this._store.delete() will target our rewritten delete
                return this._store.delete(this.primaryKey); // Will automatically delete and iegap index items as well.
            },
            update: function(newValue) {
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
            addEventListener: function(type, listener) {
                this._el[type] ? this._el[type].push(listener) : this._el[type] = [listener];
            },
            removeEventListener: function(type, listener) {
                var listeners = this._el[type];
                if (listeners) {
                    var pos = listeners.indexOf(listener);
                    if (pos !== -1) listeners.splice(pos, 1);
                }
            },
            dispatchEvent: function(event) {
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

    //
    // IEGAP version of IDBRequest
    //
    function IEGAPRequest(source, transaction, execute) {
        this._el = {};
        this.source = source;
        this.transaction = transaction;
        this.readyState = "pending";
        var thiz = this;
        var eventTargetProp = { get: function() { return thiz; } };
        execute(function(e, result) {
            //if (e.type !== 'success') Object.defineProperty(e, "type", { value: "success" });
            thiz.result = result;
            Object.defineProperty(e, "target", eventTargetProp);
            thiz.readyState = "done";
            thiz.dispatchEvent(e);
        }, function(e, err) {
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

    function blockingManystepsOperation(transaction, fn) {
        var queue = transaction.$iegQue || (transaction.$iegQue = []);
        queue.push({ execute: fn });
        if (queue.length === 1) executeQueue(transaction);
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

        // Clone all arguments first
        operation.args = deepClone(operation.args);

        IEGAPRequest(operation.store, operation.store.transaction, function (success, error, request) {
            var store = operation.store,
                transaction = store.transaction,
                queue = transaction.$iegQue || (transaction.$iegQue = []),
                op = operation.op,
                implicitKey = op == 'delete' ? operation.args[0] : operation.args.length > 1 ? operation.args[1] : store.keyPath && getByKeyPath(operation.args[0]),
                storeNameColonKey = implicitKey !== undefined && store.name + ":" + implicitKey; // If autoIncrement, implicitKey may be undefined

            extend(operation, {
                trigSuccess: success,
                trigError: error,
                req: request,
                key: implicitKey
            });

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
                var queueItem = { ops: [operation], keys: {}, autoIncStores: {} };
                if (storeNameColonKey) queueItem.keys[storeNameColonKey] = true;
                else queueItem.autoIncStores[store.name] = true;
                queue.push(queueItem);
                if (queue.length == 1) executeQueue(store.transaction);
            } else {
                lastItem.ops.push(operation);
                if (storeNameColonKey) lastItem.keys[storeNameColonKey] = true;
                else lastItem.autoIncStores[store.name] = true;
            }
        });
    }

    derive(BlockingWriteRequest).from(IEGAPRequest);

    function saveAutoIncs(transaction) {
        Object.keys(transaction.$iegapAutoIncs || {}).forEach(function(storeName) {
            OrigProtos.ObjectStore.put.apply(transaction.objectStore(STORENAME_AUTOINC),
                { currentAutoInc: transaction.$iegapAutoIncs[storeName] }, storeName)
                .onerror = fatal("saving current autoIncs");
        });
    }

    function loadAutoIncs(transaction, storeNames, cb) {
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="storeNames" type="Array" elementType="String"></param>
        if (!transaction.$iegapAutoIncs)
            transaction.$iegapAutoIncs = {};

        var nRequests = storeNames.length;
        if (nRequests === 0) return cb();

        var autoIncStore = transaction.objectStore(STORENAME_AUTOINC);

        storeNames.forEach(function (storeName) {
            if (transaction.$iegapAutoIncs.hasOwnProperty(storeName))
                checkComplete();
            else
                autoIncStore.get(storeName).onsuccess = function(ev) {
                    transaction.$iegapAutoIncs[storeName] = ev.target.result;
                    checkComplete();
                }
        });

        function checkComplete() {
            if (--nRequests) cb();
        }
    }

    function newAutoInc(store) {
        /// <param name="store" type="IDBObjectStore"></param>
        return store.transaction.$iegapAutoIncs[store.name]++;
    }

    function updateAutoInc(store, key) {
        if (!isNaN(key)) {
            var records = store.transaction.$iegapAutoIncs;
            var currentKey = records[store.name];
            if (key >= currentKey) records[store.name] = key + 1;
        }
    }

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
        if (!queue || queue.length === 0) {
            return saveAutoIncs(transaction);
        }
        var item = queue[0];
        while (typeof item == 'function') {
            // A reader found. Just call it, and the next, and the next... until empty or a "blocker" found.
            queue.shift();
            item();
            if (queue.length == 0) return saveAutoIncs(transaction);
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
        // 1. Load current autoIncrement numbers for all operations that will require such
        loadAutoIncs(transaction, Object.keys(item.autoIncStores), function () {
            // 2. Resolve undefined keys with autoIncremented keys
            resolveUndefinedKeys(transaction, operations);
            // 3. Get meta operations to execute:
            getMetaOperations(transaction, operations, function(metaOperations) {
                // 4. Execute all meta-operations:
                bulk(metaOperations, function () {
                    // 5. Handle failed meta-operations (reverting other meta-operations and modifying main-op to result in ConstraintError)
                    handleFailedMetaOperations(metaOperations, operations);
                    // 6. Execute the main operations in a bulk.
                    bulk(operations, {
                        onsuccess: function (ev, operation) {
                            // 7A: If successful, trigger the success handler
                            operation.trigSuccess(ev,
                                operation.resultMapper ?
                                operation.resultMapper(ev.target.result) : ev.target.result);
                        },
                        onerror: function (ev, operation) {
                            // 7B: If error occurs, revert meta-operations and trigger the error now!
                            if (operation.metaOps) {
                                // There were indexing operations that were successfully performed
                                // for this operation. They must be undone in case the error handler
                                // will preventDefault (prohibiting transaction from aborting)
                                bulk(operation.metaOps.map(revertMetaOperation));
                            }
                            operation.trigError(ev, ev.target.error);
                        }
                    }, function() {
                        // 8. Finally shift the queue and execute next item, if any.
                        queue.shift();
                        executeQueue(transaction);
                    });
                });
            });
        });
    }

    function handleFailedMetaOperations(metaOperations, mainOperations) {
        /// <param name="metaOperations" value="[{result: '', error: null, store: IDBObjectStore.prototype, op:'delete/add', args:[], mainOp: {store: IDBObjectStore.prototype, op: '', args: [], key: null}}]"></param>
        /// <param name="mainOperations" value="[{result: '', error: null, store: IDBObjectStore.prototype, op:'delete/add/put', args:[], key: null, trigSuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}]"></param>
        metaOperations.forEach(function (metaOperation) {
            var mainOperation = metaOperation.mainOp;

            // If the metaOperation failed, change the main operation to an operation that will fail for sure.
            if (metaOperation.error) {
                // A meta operation failed. Now, make sure its main operation will fail
                // and that all other meta operations 
                if (!mainOperation.alreadyErrified) {
                    // Make the main operation trigger an error of same type as we got
                    if (metaOperation.error.name === 'ConstraintError') {
                        // Trigger ConstraintError
                        mainOperation.store = metaOperation.store.transaction.objectStore(STORENAME_META);
                        mainOperation.op = "add";
                        mainOperation.args = [{}, 1];
                    } else {
                        // Trigger DataError
                        mainOperation.op = "delete";
                        mainOperation.args = [undefined];
                    }

                    mainOperation.alreadyErrified = true;
                }
            } else {
                // Make the main operation have a metaOps array containing all successfully performed metaOperations
                // for the main operation. This will be handy when a main operation fails because we can easily look
                // up its meta ops and revert them.
                if (!mainOperation.metaOps) mainOperation.metaOps = [metaOperation];
                else mainOperation.metaOps.push(metaOperation);
            }
        });
    }

    function revertMetaOperation(operation) {
        /// <param name="operation" value="{store: IDBObjectStore.prototype, op: 'add/delete', args: []}"></param>
        var idxPrimKey;
        if (operation.op === 'delete') {
            idxPrimKey = operation.args[0];
            var array = stringToCompound(key);
            var idxObj = { fk: array[0], k: array[1] };
            return { store: op.store, op: 'add', args: [idxObj, idxPrimKey] };
        } else {
            idxPrimKey = operation.args[1];
            return { store: op.store, op: 'delete', args: [idxPrimKey] };
        }
    }

    function resolveUndefinedKeys(transaction, operations) {
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="operations" value="[{result: '', error: null, store: IDBObjectStore.prototype, op:'delete/add/put', args:[], key: null, trigSuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}]"></param>
        operations.forEach(function (operation) {
            if ((operation.op === 'add' || operation.op === 'put') && operation.store.autoIncrement) {
                if (operation.key === undefined) {
                    operation.key = newAutoInc(operation.store);
                    if (operation.store.keyPath)
                        setByKeyPath(operation.args[0], operation.store.keyPath, operation.key);
                    else
                        operation.args[1] = operation.key;
                } else {
                    updateAutoInc(operation.store, operation.key);
                }
            }
        });
    }

    function getMetaOperations(transaction, operations, cb) {
        /// <param name="transaction" type="IDBTransaction"></param>
        /// <param name="operations" value="[{result: '', error: null, store: IDBObjectStore.prototype, op:'delete/add/put', args:[], key: null, trigSuccess: function(){}, trigError: function(){}, req: BlockingManystepsRequest.prototype}]"></param>
        var nRequests = 1,
            metaOperations = [];

        operations.forEach(function (operation) {
            //if (operation.error) return; // dont execute meta operation if main operation failed
            var op = operation.op,
                meta = getMeta(operation.store),
                primKey = operation.key,
                indexes = Object.keys(meta.indexes)
                    .map(function(name) {
                        return meta.indexes[name];
                    });

            if (!isValidKey(primKey))
                return; // Don't put any indexes for invalid primary keys. The main operation will fail anyway.

            if (op === 'add') {
                indexes.forEach(function (indexMeta) {
                    generateIndexingOperations(transaction, operation.args[0], primKey, indexMeta, metaOperations);
                });
            } else if (op == 'put') {
                // Read existing meta-indexes, diff with indexKeys and map to metaOperations
                indexes.forEach(function(indexMeta) {
                    ++nRequests;
                    listExistingIndexes(indexMeta, primKey, function(existingIndexesPrimKeys) {
                        var partialMetaOps = [];
                        generateIndexingOperations(transaction, operation.args[0], primKey, indexMeta, partialMetaOps);
                        // Diff with existing indexes:
                        partialMetaOps.forEach(function(metaOp) {
                            // Only include index additions that did not already exist.
                            // We check this by trying to find whether the primary key of the index to add did already exist
                            if (!existingIndexesPrimKeys[metaOp.args[1]]) {
                                metaOperations.push(metaOp);
                            } else {
                                delete existingIndexesPrimKeys[metaOp.args[1]];
                            }
                        });
                        // Now delete existing indexes that was not to be added
                        Object.keys(existingIndexesPrimKeys).forEach(function (idxToDeletePk) {
                            metaOperations.push({
                                store: transaction.objectStore(indexMeta.idxStoreName),
                                op: 'delete',
                                args: [idxToDeletePk],
                                mainOp: operation
                            });
                        });
                        checkComplete();
                    });
                });
            } else if (op == 'delete') {
                // Read all existing meta-indexes to delete and map to delete()-metaOperations.
                indexes.forEach(function(indexMeta) {
                    ++nRequests;
                    listExistingIndexes(indexMeta, primKey, function(existingIndexesPrimKeys) {
                        Object.keys(existingIndexesPrimKeys).forEach(function(idxToDeletePk) {
                            metaOperations.push({
                                store: transaction.objectStore(indexMeta.idxStoreName),
                                op: 'delete',
                                args: [idxToDeletePk],
                                mainOp: operation
                            });
                        });
                        checkComplete();
                    });
                });
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

    function listExistingIndexes(indexMeta, primaryKey, cb) {
        /// <summary>
        /// 
        /// </summary>
        /// <param name="indexMeta" type="IIndexMeta">Index specification to iterate</param>
        /// <param name="primaryKey">Primary key of the object to list indexes for</param>
        /// <param name="cb">function (result){} where result is a set of primary keys of the idxObjectStore]</param>
        var idxStore = transaction.objectStore(indexMeta.idxStoreName);
        var pkIndex = OrigProtos.ObjectStore.index.call(idxStore, "pk");
        var req = pkIndex.openKeyCursor(primaryKey);
        var result = {};
        req.onerror = ignore("retrieving existing indexes", function() { cb(result); });
        req.onsuccess = function() {
            var cursor = req.result;
            if (!cursor) { cb(result); return; }
            result[cursor.primaryKey] = true;
            cursor.continue();
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
                        var existingStoreNames = OrigProtos.DB.objectStoreNames.get.apply(db);
                        if (!existingStoreNames.contains(STORENAME_META)) {
                            var metaStore = OrigProtos.DB.createObjectStore.call(db, STORENAME_META);
                            metaStore.add(db._iegapmeta, 1);
                        }
                        if (!existingStoreNames.contains(STORENAME_AUTOINC)) {
                            OrigProtos.DB.createObjectStore.call(db, STORENAME_AUTOINC);
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
            return function (name, keyPath, props) {
                if (Array.isArray(keyPath) || (props && props.multiEntry))
                    return createIndex(this, name, keyPath, props || {});
                return origFunc.apply(this, arguments);
            }

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
                    OrigProtos.DB.createObjectStore.call(db, name, { keyPath: true }); // Will throw DOMException.INVALID_ACCESS_ERR
                    throw "invalid access"; // fallback.
                }
                var idxStore = OrigProtos.DB.createObjectStore.call(db, idxStoreName);

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
                var highestKey = 0;
                // Only need to start intercepting autoIncrement handling if this is the first time
                // that an intercepted index was created.
                // (or after all has been deleted and then first one created again)
                var registerHighestKey = storeMeta.autoIncrement && storeMeta.metaStores.length === 1;
                blockingManystepsOperation(store.transaction, function (done) {
                    var indexingOperations = [];
                    var req = OrigProtos.ObjectStore.openCursor.call(store);
                    // If error, let us be done, but don't swallow the error. Transaction should abort actually.
                    req.onerror = done;
                    req.onsuccess = function (ev) {
                        var cursor = req.result;
                        if (cursor) {
                            try {
                                var primaryKey = cursor.primaryKey;

                                if (registerHighestKey && !isNaN(primaryKey) && primaryKey > highestKey)
                                    highestKey = cursor.primaryKey;

                                generateIndexingOperations(transaction, cursor.value, primaryKey, indexMeta, indexingOperations);
                                if (indexingOperations.length > 1000) {
                                    // Since we are iterating the entire table, existing data may
                                    // theoretically be too huge for RAM.
                                    // Let's execute parts of the indexing operations here and continue iterating the object store.
                                    // Reason for null: No need to be notified back when done. We'll do that in the final bulk().
                                    // (IDB spec requires all onsuccess/onerror to be called in the same order as the operation was called)
                                    // Reason for swallowErrors=false: IDB spec requires upgradeTransaction to abort if an index fails to
                                    // be added. Such situation could occur if the index is marked as unique and two objects have same key.
                                    bulk(indexingOperations, { swallowErrors: false }, null);
                                    indexingOperations = [];
                                }
                            } catch (e) {
                                console.error(e);
                                store.transaction.abort();
                            }
                            cursor.continue();
                        } else {
                            bulk(indexingOperations, { swallowErrors: false }, done);
                            if (registerHighestKey)
                                OrigProtos.ObjectStore.put.call(
                                    store.transaction.objectStore(STORENAME_AUTOINC),
                                    { currentAutoInc: highestKey + 1 }, store.name);
                        }
                    }
                });

                return new IEGAPIndex(keyIndex, store, name, keyPath, props.multiEntry);
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
                OrigProtos.DB.deleteObjectStore.call(db, indexMeta.idxStoreName);
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
                    var stringifiedKey = compoundToString(getByKeyPath(value, meta.keyPath));
                    var args = [value, stringifiedKey];
                    if (key !== undefined) args = [{}, null]; // // Trigger DOMException(DataError)!     
                    return new BlockingWriteRequest({
                        store: this,
                        op: 'add',
                        args: args,
                        resultMapper: function (result) { return stringToCompound(result); }
                    });
                }
                var indexes = Object.keys(meta.indexes);
                if (indexes.length === 0) return origFunc.apply(this, arguments); // No indexes to deal with
                return new BlockingWriteRequest({
                    store: this,
                    op: 'add',
                    args: arguments
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
                    value: function (storeNames, mode) {
                        storeNames = typeof storeNames == 'string' ? [storeNames] : [].slice.call(storeNames);
                        var storesWithMeta = this._iegapmeta.stores;
                        storeNames.forEach(function (name) {
                            var meta = storesWithMeta[name];
                            if (meta) storeNames = storeNames.concat(meta.metaStores);
                        });
                        if (mode === "readwrite") storeNames.push(STORENAME_AUTOINC);
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
            createObjectStore: function() {
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
                            // Create the object store normally.
                            rv = OrigProtos.DB.createObjectStore.apply(this, arguments);
                        } else {
                            compound = true;
                            if (props.autoIncrement) throw new RangeError("Cannot autoincrement compound key");
                            // Caller provided an array as keyPath. Need to polyfill:
                            // Create the ObjectStore without inbound keyPath:
                            rv = OrigProtos.DB.createObjectStore.call(this, storeName);
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
                        this._upgradeTransaction.objectStore(STORENAME_AUTOINC).delete(storeName);
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
            autoIncrement: false,
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
})(typeof(indexedDB) !== 'undefined' ? indexedDB : msIndexedDB);
