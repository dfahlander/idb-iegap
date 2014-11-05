(function (idb, undefined) {
    /*
     * Gaps if IE10 and IE11:
     *      * The lack of compound indexes
     *      * The lack of support for multivalued keys
     *
     * Where to inject?
     * 
     *      V IDBObjectStore.createIndex(name, [keyPath1, keypath2], { unique: true/false, multiEntry: true });
     *          What to do?
     *              1) If keyPath is an array, create a new table ($iegap-<table>-<indexName> with autoinc, key "key" (unique?) and value "primKey" of this table
     *                 If multiEntry is true, create a new table ($iegap-<table>-<indexName> with autoinc, key "key" and value "primKey" of this table.
     *              2) Dont create the real index but store the index in localStorage key ("$iegap-<table>")
     *                  { indexes: [{name: "", keyPath, ...
     *      * IDBObjectStore.deleteIndex()
     *          1) Return the compound result of real indexNames and the ones in $iegap-<table>-indexes
     *      V IDBObjectStore.index("name")
     *          * If the name corresponds to a special index, return a fake IDBIndex with its own version of openCursor()
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
     *          * compound: Iterate the own table, use a fake cursor object to point out correct primary key and value
     *          * IEGapCursor.delete(): delete the object itself along with the index objects pointing to it. HOW WILL IE REACT WHEN SAWING OF ITS OWN BRANCH IN AN ITERATION. We might have to restart the query with another upperBound/lowerBound request.
     *          * IEGapCursor.update(): Do a put() on the object itself. WHAT HAPPENS IF PUT/DELETE results in deleting next-coming iterations? We might have to restart the quer with another upperBound/lowerBound request.
     *          * Support nextunique and prevunique by just using it on the index store.
     *      V IDBDatabase.transaction(): Make sure to include all meta-tables for included object stores.
     *      * IDBDatabase.deleteObjectStore()
     *      * Detect IE10/IE11.
     *
     *  Over-course:
     *      V IDBObjectStore.indexNames: Filter away those names that contain metadata
     *      V IDBDatabase.objectStoreNames: Filter away those names that contain metadata
     *      V indexedDB.open(): extend the returned request and override onupgradeneeded so that main meta-table is created
     *      V                            "                               onsuccess so that the main meta-table is read into a var stored onto db.
     *      * IDBTransaction.objectStore(): Populate the "autoIncrement" property onto returned objectStore. Need to have that stored if so.
     *      * readyState in IEGAPRequest
     *      * currentTarget in IEGAPRequest (other props as well?)
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

    function ignore(op, cb) {
        return function (ev) {
            console.log("Warning: IEGap polyfill failed to " + (op.call ? op() : op) + ": " + ev.target.error);
            ev.stopPropagation();
            ev.preventDefault();
            cb();
            return false;
        }
    }

    function addCompoundIndexKey(idxStore, indexSpec, value, primKey, onfinally) {
        /// <param name="idxStore" type="IDBObjectStore">The object store for meta-indexes</param>
        try {
            var idxKeys = getByKeyPath(value, indexSpec.keyPath);
            if (idxKeys === undefined) return onfinally(); // no key to add index for
            var req = idxStore.add({ fk: primKey, k: compoundToString(idxKeys) });
            req.onerror = ignore("add compound index", onfinally);
            req.onsuccess = onfinally;
        } catch (ex) {
            console.log("IEGap polyfill exception when adding compound index key");
            onfinally();
        }
    }

    function addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, onfinally) {
        /// <param name="idxStore" type="IDBObjectStore">The object store for meta-indexes</param>
        try {
            var idxKeys = getByKeyPath(value, indexSpec.keyPath);
            if (idxKeys === undefined) return onfinally(); // no key to add index for.
            if (!Array.isArray(idxKeys)) {
                // the result of evaluating the index's key path doesn't yield an Array
                var req = idxStore.add({ fk: primKey, k: idxKeys });
                req.onerror = ignore("add index", onfinally);
                req.onsuccess = onfinally;
            } else {
                // the result of evaluating the index's key path yields an Array
                idxKeys.forEach(function(idxKey) {
                    var req = idxStore.add({ fk: primKey, k: idxKey });
                    req.onerror = ignore(function() { return "add multiEntry index " + idxKey + " for " + indexSpec.storeName + "." + indexSpec.keyPath ; }, checkComplete);
                    req.onsuccess = checkComplete;
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

    //
    // Constants and imports
    //
    var POWTABLE = {};
    var IDBKeyRange = window.IDBKeyRange,
        IDBObjectStore = window.IDBObjectStore,
        IDBDatabase = window.IDBDatabase;

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
                    rv[i] = "u" // undefined
                else
                    rv[i] = "0" // null
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

    function getMeta(db) {
        /// <param name="db" type="IDBDatabase"></param>
        /// <returns value="{stores: {storeName: {metaStores: [], indexes: {indexName: {name:'',keyPath:null,multiEntry:false,unique:false,compound:false,idxStoreName:'',storeName:''}}}}}"></returns>
        return db._iegapmeta;
    }
    function setMeta(db, transaction, value) {
        /// <param name="db" type="IDBDatabase"></param>
        /// <param name="transaction" type="IDBTransaction"></param>
        db._iegapmeta = value;
        transaction.objectStore('$iegapmeta').put(value, 1);
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
            return new IEGAPRequest(iegIndex, iegIndex.objectStore.transaction, function (success, error) {
                var compound = Array.isArray(iegIndex.keyPath);
                if (compound && Array.isArray(range)) range = new IEGAPKeyRange(range, range);
                var idbRange = compound && range ?
                    IDBKeyRange.bound(compoundToString(range.lower), compoundToString(range.upper), range.lowerOpen, range.upperOpen) :
                    range;
                
                var req = iegIndex._idx.openCursor(idbRange, dir);
                req.onerror = error;
                if (includeValue) {
                    req.onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        if (cursor) {
                            var getreq = iegIndex._store.get(cursor.value.fk);
                            getreq.onerror = error;
                            getreq.onsuccess = function () {
                                var key = compound ? getByKeyPath(getreq.result, iegIndex.keyPath) : cursor.key;
                                success(ev, new IEGAPCursor(cursor, dir, range, iegIndex, key, getreq.result));
                            }
                        } else {
                            success(ev, null);
                        }
                    }
                } else {
                    req.onsuccess = function(ev) {
                        var cursor = ev.target.result;
                        var key = compound ? stringToCompound(cursor.key) : cursor.key;
                        success(ev, cursor && new IEGAPCursor(cursor, dir, range, key, iegIndex));
                    }
                }
            });
        }

        return {
            count: function(key) {
                return key === undefined ? this._idx.count() : this._idx.count(key);
            },
            get: function(key) {
                var thiz = this;
                var req = this._idx.get(key);
                return new IEGAPRequest(this, this.objectStore.transaction, function(success, error) {
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
                var req = this._idx.get(key);
                return new IEGAPRequest(this, this.objectStore.transaction, function (success, error) {
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

    function IEGAPCursor(idbCursor, dir, range, iegapIndex, key, value) {
        /// <param name="idbCursor"></param>
        /// <param name="dir"></param>
        /// <param name="range"></param>
        /// <param name="iegapIndex" type="IEGAPIndex"></param>
        /// <param name="value"></param>
        this._cursor = idbCursor;
        this.direction = dir;
        this.key = key;
        this.primaryKey = idbCursor.value.fk;
        this.source = iegapIndex;
        if (arguments.length >= 6) this.value = value;
    }

    extend(IEGAPCursor.prototype, function() {
        return {
            advance: function(n) {
                this._cursor.advance(n);
            },
            "continue": function(key) {
                /// <param name="key" optional="true"></param>
                if (!key) return this._cursor.continue();
                if (Array.isArray(key)) return this._cursor.continue(compoundToString(key));
                this._cursor.continue(key);
            },
            "delete": function () {
                return this.source.objectStore.delete(this.primaryKey);// Will automatically delete and iegap index items as well.
                // req.target will be the object store and not the cursor. Let it be so for now.
                // TODO: Låtsas som det regnar och fortsätt här. Testa sedan vad som händer om man deletar
                // ett objekt som resulterar i att en massa multiValue indexes deletas och därmed att
                // cursor.continue falierar eller beter sig märkligt. Kanske är det upp till implementatören att vänta på delete() requestet eller?
                // Hur beter sig IDB i detta läge (de som har stöd för multiValue index)?
            },
            update: function(newValue) {
                // Samma eventuella problem här som med delete(). Frågan är var ansvaret ligger för att inte fortsätta jobba med 
                // en collection som håller på att manipuleras. API usern eller IDB?
                return this.source.objectStore.put(this.primaryKey, newValue);
            }
        }
    });

    function IEGAPEventTarget() {
        this._el = {};
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
                if (listener && listener(event) === false) return false;
                var listeners = this._el[event.type];
                if (listeners) {
                    for (var i = 0, l = listeners.length; i < l; ++i) {
                        listener = listeners[i];
                        if ((listener.handleEvent || listener)(event) === false) return false;
                    }
                    return true;
                }
            }
        }
    });

    //
    // IEGAP version of IDBRequest
    //
    function IEGAPRequest(source, transaction, deferred) {
        this._el = {};
        this.source = source;
        this.transaction = transaction;
        var thiz = this;
        var eventTargetProp = { get: function () { return thiz; } };
        deferred(function (e, result) {
            thiz.result = result;
            Object.defineProperty(e, "target", eventTargetProp);
            thiz.dispatchEvent(e);
        }, function (e, err) {
            thiz.error = err || e.target.error;
            Object.defineProperty(e, "target", eventTargetProp);
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
    function IEGAPOpenRequest() {
        IEGAPRequest.apply(this, arguments);
    }
    derive(IEGAPOpenRequest).from(IEGAPRequest).extend({
        onblocked: null,
        onupgradeneeded: null
    });


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
    // DOMStringList
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

        initPowTable();

        //
        // Inject into onupgradeneeded and onsuccess in indexedDB.open()
        //
        idb.open = override(idb.open, function(orig) {
            return function (name, version) {
                var req = orig.apply(this, arguments);
                return new IEGAPOpenRequest(this, null, function (success, error, iegReq) {
                    req.onerror = error;
                    req.onblocked = iegReq.dispatchEvent;
                    req.onupgradeneeded = function (ev) {
                        iegReq.transaction = req.transaction;
                        var db = (iegReq.result = req.result);
                        db._iegapmeta = { stores: {} };
                        if (!getObjectStoreNames.apply(db).contains("$iegapmeta")) {
                            var store = db.createObjectStore("$iegapmeta");
                            store.add(db._iegapmeta, 1);
                        }
                        ev.target = ev.currentTarget = iegReq;
                        iegReq.dispatchEvent(ev);
                    }
                    req.onsuccess = function(ev) {
                        var db = req.result;
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
                return new IEGAPKeyRange(bound, null, open);
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
                var meta = getMeta(db);
                if (props.multiEntry && Array.isArray(keyPath)) {
                    // IDB spec require us to throw DOMException.INVALID_ACCESS_ERR
                    db.createObjectStore("dummy", { keyPath: "", autoIncrement: true }); // Will throw DOMException.INVALID_ACCESS_ERR
                    throw "invalid access"; // fallback.
                }
                var idxStore = db.createObjectStore(idxStoreName, { autoIncrement: true });

                var storeMeta = meta.stores[store.name] || (meta.stores[store.name] = {indexes: {}, metaStores: [] });
                storeMeta.indexes[name] = {
                    name: name,
                    keyPath: keyPath,
                    multiEntry: props.multiEntry || false,
                    unique: props.unique || false,
                    compound: Array.isArray(keyPath),
                    storeName: store.name,
                    idxStoreName: idxStoreName
                };
                storeMeta.metaStores.push(idxStoreName);
                idxStore.createIndex("fk", "fk", { unique: false });
                var keyIndex = idxStore.createIndex("k", "k", { unique: props.unique || false });
                setMeta(db, store.transaction, meta);
                return new IEGAPIndex(keyIndex, store, name, keyPath, props.multiEntry);
            }

            return function (name, keyPath, props) {
                if (Array.isArray(keyPath) || (props && props.multiEntry))
                    return createIndex(this, name, keyPath, props || {});
                return origFunc.apply(this, arguments);
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

        IDBObjectStore.prototype.add = override(IDBObjectStore.prototype.add, function (origFunc) {
            return function(value, key) {
                var addReq = origFunc.apply(this, arguments);
                var meta = getMeta(this.transaction.db).stores[this.name];
                if (!meta) return addReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function(success, error) {
                    var indexes = Object.keys(meta.indexes);
                    var addEvent = null, indexAddFinished = false;
                    var primKey = key || (store.keyPath && getByKeyPath(value, store.keyPath));
                    addReq.onerror = function(e) {
                        if (!error(e)) {
                            // error listener stopped propagation (transaction will commit)
                            // need to manually rollback added keys:
                            if (primKey) rollbackIndexKeysAdds();
                            e.stopPropagation();
                            e.preventDefault();
                            return false;
                        }
                    }
                    if (primKey) addIndexKeys(); // Caller provided primKey - we can start adding indexes at once! No need waiting for onsuccess.
                    addReq.onsuccess = function (ev) {
                        addEvent = ev;
                        if (primKey) { // Caller provided the primkey
                            checksuccess();
                        } else {
                            primKey = addReq.result;
                            addIndexKeys();
                        }
                    }

                    function checksuccess() {
                        if (indexAddFinished && addEvent) success(addEvent, addReq.result);
                    }

                    function addIndexKeys() {
                        var nRequests = indexes.length;
                        if (nRequests === 0) return checksuccess();
                        indexes.forEach(function (indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            if (indexSpec.multiEntry) {
                                addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, checkComplete);
                            } else if (indexSpec.compound) {
                                addCompoundIndexKey(idxStore, indexSpec, value, primKey, checkComplete);
                            } else {
                                throw "IEGap assert error";
                            }
                        });

                        function checkComplete() {
                            if (--nRequests === 0) checksuccess();
                        }
                    }

                    function rollbackIndexKeysAdds() {
                        indexes.forEach(function (indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            bulkDelete(idxStore.index("fk"), key, function() {});
                        });
                    }
                });
            }
        });

        IDBObjectStore.prototype.put = override(IDBObjectStore.prototype.put, function (origFunc) {
            return function (value, key) {
                var putReq = origFunc.apply(this, arguments);
                var meta = getMeta(this.transaction.db).stores[this.name];
                if (!meta) return putReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function (success, error) {
                    var indexes = Object.keys(meta.indexes);
                    var putEvent = null;
                    var primKey;
                    putReq.onerror = error;
                    putReq.onsuccess = function (ev) {
                        putEvent = ev;
                        primKey = putReq.result;
                        replaceIndexKeys();
                    }

                    function replaceIndexKeys() {
                        var nRequests = indexes.length * 2;
                        if (nRequests === 0) return success(putEvent, primKey);
                        indexes.forEach(function(indexName) {
                            var indexSpec = meta.indexes[indexName];
                            var idxStore = store.transaction.objectStore(indexSpec.idxStoreName);
                            bulkDelete(idxStore.index("fk"), primKey, checkComplete);
                            if (indexSpec.multiEntry) {
                                addMultiEntryIndexKeys(idxStore, indexSpec, value, primKey, checkComplete);
                            } else if (indexSpec.compound) {
                                addCompoundIndexKey(idxStore, indexSpec, value, primKey, checkComplete);
                            } else {
                                throw "IEGap assert error";
                            }
                        });

                        function checkComplete() {
                            if (--nRequests === 0) success(putEvent, primKey);
                        }
                    }
                });
            }
        });

        IDBObjectStore.prototype.delete = override(IDBObjectStore.prototype.delete, function (origFunc) {
            return function (key) {
                var delReq = origFunc.apply(this, arguments);
                var meta = getMeta(this.transaction.db).stores[this.name];
                if (!meta) return delReq;
                var store = this;
                return new IEGAPRequest(this, this.transaction, function (success, error) {
                    var indexes = Object.keys(meta.indexes);
                    var delEvent = null;
                    delReq.onerror = error;
                    delReq.onsuccess = function(ev) {
                        delEvent = ev;
                        deleteIndexKeys();
                    }

                    function deleteIndexKeys() {
                        var nRequests = indexes.length;
                        if (nRequests === 0) return success(delEvent);
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
                var clearReq = origFunc.apply(this, arguments);
                var meta = getMeta(this.transaction.db).stores[this.name];
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
                        var storesWithMeta = getMeta(this).stores;
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
            }
        });
    }

    Constructor();
})(window.indexedDB || window.msIndexedDB);
