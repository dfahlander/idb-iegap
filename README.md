compound-and-multientry-for-ie
==============================

There's been some years since Internet Explorer launched their IndexedDB support. The IE version however, lacked the support for compound and multivalued indexes. Since summer 2014, all major browsers including the latest version of Safari support the IndexedDB specification. Now it's only IE that is the odd fellow that lacks the full specification.

This polyfill makes IE10 / IE11 support almost the complete IndexedDB specification by implementing support for compound and multiEntry index.

Compound Index in IE
--------------------

It is now possible to have an index compound by an array of keyPaths making it possible to do more efficient intersection (AND) operations. The only missing part for IE is now to be able to use an array as primary key (compound primary key). The polyfill could easily be extended to support that as well.

MultiEntry Index in IE
----------------------

It is now possible to have a multiValued index - that is, letting a property of a persistant object be an array and automatically index each item in the array, so that it is possible to lookup the object based on any of the keys stored in its array-property.

Tested against W3C web-platform-tests
-------------------------------------
The polyfill is tested against the W3C web-platform-test suite that applies to IndexedDB and multi-entry and compund indexes. A fork of the W3C web-platform-test suite that includes this polyfill, can be found at https://github.com/dfahlander/web-platform-tests

Tested with Dexie.js
--------------------
THe polyfill is tested with the unit tests of Dexie.js. (Currently with one issue: See  https://github.com/dfahlander/compound-and-multientry-for-ie/issues/1)


Please help me test and simplify, optimize or extend this polyfill.

