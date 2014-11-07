compound-and-multientry-for-ie
==============================

There's been some years since Internet Explorer launched their IndexedDB support. The IE version however, lacked the support for compound and multivalued indexes. Since summer 2014, all major browsers including the latest version of Safari support the IndexedDB specification. Now it's only IE that is the odd fellow that lacks the full specification.

This polyfill makes IE10 / IE11 support the complete IndexedDB specification by implementing support for compound and multiEntry index as well as using compound primary keys.

Compound Index in IE
--------------------

It is now possible to have an index compound by an array of keyPaths making it possible to do more efficient intersection (AND) operations. In the last commit, I also made support for using an array as keyPath for the ObjectStore itself (the primary key will is compound). This is specified in the IDB specification and tested in W3C web-platform-test suite. All other browsers supports this except IE.

MultiEntry Index in IE
----------------------

It is now possible to have a multiValued index - that is, letting a property of a persistant object be an array and automatically index each item in the array, so that it is possible to lookup the object based on any of the keys stored in its array-property. All other browsers supports this except IE.

Tested against W3C web-platform-tests
-------------------------------------
The polyfill is tested against the W3C web-platform-test suite that applies to IndexedDB and multi-entry and compund indexes. A fork of the W3C web-platform-test suite that includes this polyfill, can be found at https://github.com/dfahlander/web-platform-tests

Tested with Dexie.js
--------------------
The polyfill is tested with the unit tests of Dexie.js.


Please help me test, bugfix, simplify, optimize and spread this polyfill.

