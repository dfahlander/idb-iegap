**NOTICE!**
This library has not been maintained for several months. I've started a full rewrite of the library during Spring 2015 but the rewrite is still in a non-working state. Contributions to the branch "big-rewrite" are more than welcome! The architecural rewrite is complete and finished, but it still fails in all tests. What I need is time to test and debug it, but ovdiously, i've failed to get the time to do that and i don't see so much light in the tunnel for that during the nearest future. So once again, please help me debug the branch "big-rewrite" ;)

Reason for rewrite: The polyfill didn't handle bulks of put(), add() and delete() correctly. This is filed as [Issue #4](https://github.com/dfahlander/idb-iegap/issues/4). 


Compound and MultiEntry Indexes with IE
=======================================

There's been some years since Internet Explorer launched their IndexedDB support. The IE version however, lacked the support for compound and multivalued indexes. Since summer 2014, all major browsers including the latest version of Safari support the IndexedDB specification, even though the Safari implementation isn't yet robust. Now it's only IE that is the odd fellow that lacks the support for compound and multiEntry indexes.

* Chrome has it!
* Firefox has it!
* Opera has it!
* Safari has it!
* Internet Explorer has it "almooooost", if it wasn't for that irritating multiEntry / compound index support!!!

This polyfill makes IE10 / IE11 support the complete IndexedDB specification by implementing support for compound and multiEntry index as well as using compound primary keys.

Installation
------------
Download the source yourself, or use bower:

    bower install idb-iegap

Compound Index
--------------

It is now possible to have an index compound by an array of keyPaths making it possible to do more efficient intersection (AND) operations. In the last commit, I also made support for using an array as keyPath for the ObjectStore itself (the primary key will is compound). This is specified in the IDB specification and tested in W3C web-platform-test suite.

MultiEntry Index
----------------

It is now possible to have a multiValued index - that is, letting a property of a persistant object be an array and automatically index each item in the array, so that it is possible to lookup the object based on any of the keys stored in its array-property.

Tested against W3C web-platform-tests
-------------------------------------
The polyfill is tested against the W3C web-platform-test suite that applies to IndexedDB and multi-entry and compund indexes. A fork of the W3C web-platform-test suite that includes this polyfill, can be run at: http://testidbiegap.dexie.org. The source of the fork is found here: https://github.com/dfahlander/web-platform-tests


Tested with [Dexie.js](http://www.dexie.org)
--------------------
The polyfill is tested with the unit tests of [Dexie.js](http://www.dexie.org). There are one test that fails though, probably due to [Issue #4](https://github.com/dfahlander/idb-iegap/issues/4).


Please help me test, bugfix, simplify, optimize and spread this polyfill in branch "big-rewrite" (See leading notice).

