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
    });

    db.open();

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

})();
