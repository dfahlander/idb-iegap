///<reference path="../bower_components/qunit/qunit/qunit.js" />
///<reference path="../bower_components/dexie/dist/latest/Dexie.js" />

(function () {

    var db = new Dexie("iegap-unit-test-database");
    db.version(1).stores({
        users: '[customer+userid],userid,[customer+displayName],*&email'
    });
    db.on('populate', function () {
        db.users.add({
            customer: "awarica",
            userid: "dfahlander",
            email: ["david@awarica.com","david.fahlander@gmail.com"],
            displayName: "David"
        });
        for (var i = 2; i <= 100; ++i) {
            db.users.add({
                customer: "awarica" + i,
                userid: "dfahlander" + i,
                email: ["david" + i + "@awarica.com", "david.fahlander" + i + "@gmail.com"],
                displayName: "David" + i
            });
        }
    });

    stop();
    db.delete().then(function () {
        return db.open();
    }).then(function() {
        start();
    });

    asyncTest("compound-primary-key", function () {
        db.users.get(["awarica", "dfahlander"], function (user) {
            ok(!!user, "User found");
            equal(user.userid, "dfahlander", "User correct");
        }).catch(function (err) {
            ok(false, err);
        }).finally(start);
    });

    asyncTest("compound-key", function () {
        db.users.where("[customer+displayName]").equals(["awarica","David"]).first(function (user) {
            ok(!!user, "User found");
            equal(user.userid, "dfahlander", "User correct");
        }).catch(function (err) {
            ok(false, err);
        }).finally(start);
    });

    asyncTest("multiEntry-key", function () {
        db.users.get(["awarica", "dfahlander"], function (user) {
            ok(!!user, "User found");
            equal(user.userid, "dfahlander", "User correct");
            user.email.push("dfahlander@hotmail.com");
            return db.users.put(user);
        }).then(function () {
            return db.users.where("email").equals("dfahlander@hotmail.com").first();
        }).then(function (user) {
            ok(!!user, "User found by new multiENtry key");
            equal(user.userid, "dfahlander", "User correct");
            user.email.pop();
            return db.users.put(user);
        }).then(function () {
            return db.users.where("email").equals("dfahlander@hotmail.com").count();
        }).then(function (count) {
            equal(count, 0, "Should not find any user on that deleted email anymore");
        }).catch(function (err) {
            ok(false, err);
        }).finally(start);
    });

    asyncTest("bulk-modify", function() {
        db.transaction(function() {
            var modSuffix = " (modified)";

            // 1. Modify all:
            db.users.toCollection().modify(function(person) {
                person.customer += modSuffix;
                person.displayName += modSuffix;
                person.email[0] += modSuffix;
                person.userid += modSuffix;
            }).then(function() {
                // 2a: Verify an item to check multiEntry index works:
                return db.users.where("email").equals("david.fahlander73@gmail.com" + modSuffix).first();
            }).then(function(person) {
                ok(!!person, "Person found");
                equal(person.displayName, "David73", "Got the right person");
            }).then(function() {
                // 2b: Verify compound primary key working
                return db.users.get(["awarica73", "dfahlander73"]);
            }).then(function(person) {
                ok(!!person, "Person found");
                equal(person.displayName, "David73", "Got the right person");
            }).then(function () {
                // 2c: Verify compound index working
                return db.users.where("[customer+displayName]").between(["awarica", ""], ["awarica2"], "z").toArray();
            }).then(function (persons) {
                equal(persons.length, 2, "Should get two persons");
                equal(persons[0].name, "David");
                equal(persons[1].name, "David2");
            }).then(function () {
                // 3. Revert back
                return db.users.toCollection().modify(function(person) {
                    person.customer = person.customer.substr(0, person.customer.indexOf(modSuffix));
                    person.displayName = person.displayName.substr(0, person.displayName.indexOf(modSuffix));
                    person.email[0] = person.email[0].substr(0, person.email[0].indexOf(modSuffix));
                    person.userid = person.userid.substr(0, person.userid.indexOf(modSuffix));
                });
            }).catch(function(err) {
                ok(false, err);
            });
        }).catch(function(err) {
            ok(false, err);
        }).finally(start);
    });

    asyncTest("error-with-rollback1", function () {
        db.transaction('rw', db.users, function() {
            // TODO: Fixthis!
        }).catch(function(err) {
            ok(false, err);
        }).finally(start);
    });
})();
