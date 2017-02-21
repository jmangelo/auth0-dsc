#!/usr/bin/env node

"use strict";

const fs = require("fs");
const url = require("url");

const _ = require("lodash");
const yaml = require("js-yaml");
const request = require("superagent");
const mustache = require("mustache");

const auth0 = require("auth0");

module.exports = function (template, config, account) {
  config = config || {};
  account = Object.assign({}, account);

  if (account.clientId || account.clientSecret) {
    getAccessToken(account.domain, account.clientId, account.clientSecret).then(token => {
      account.token = token;

      execute(template, config, account);
    })
  } else {
    account.clientId = jwt(account.token).sub.split("@")[0];

    execute(template, config, account);
  }
};

if (require.main == module) { cli(); }

function execute(template, config, account) {
  var dsc;

  try {
    mustache.tags = ["${{", "}}"];

    dsc = yaml.safeLoad(mustache.render(template, config));

    mustache.tags = ["#{{", "}}"];
  } catch (error) {
    return Promise.reject(error);
  }

  let collections = [
    { name: "apis", key: function () { return this.name; } },
    { name: "clients", key: function () { return this.name; } },
    { name: "connections", key: function () { return this.name; } },
    {
      name: "users",
      key: function () { return this.connection + "|" + (this.email || this.username); },
      preprocess: function () { this.connection = this.connection.key || this.connection; }
    },
    { name: "rules", key: function () { return this.name; } }
  ];

  var current = {};
  var configured = {};

  collections.forEach(collection => {
    current[collection.name] = [];
    configured[collection.name] = {};

    let elements = dsc[collection.name] = dsc[collection.name] || [];

    elements.forEach(element => {
      if (collection.preprocess) {
        collection.preprocess.call(element);
      }

      Object.defineProperty(element, "_alias", { enumerable: false });
      Object.defineProperty(element, "key", { enumerable: false, get: collection.key });
      Object.defineProperty(element, "alias", {
        enumerable: false,
        get: function () {
          return element._alias || (elements.length === 1 && "default") || element.key
        }
      });
    });
  });

  // console.log(JSON.stringify(dsc, null, 2));
  // return Promise.resolve(configured);

  var mgt = new auth0.ManagementClient(account);

  // Immediate stage
  var stage0 = [Promise.resolve(1)];

  // Delayed stages
  var stage1 = [() => Promise.resolve(1)];
  var stage2 = [() => Promise.resolve(1)];
  var stage3 = [() => Promise.resolve(1)];
  var stage4 = [() => Promise.resolve(1)];

  if (dsc.apis.length > 0) {
    stage0.push(mgt.resourceServers.getAll({ fields: "name,id" }).then(apis => current.apis = apis));
  }

  if (dsc.clients.length > 0) {
    stage0.push(mgt.clients.getAll({ fields: "name,client_id" }).then(clients => current.clients = clients));
  }

  if (dsc.connections.length > 0) {
    stage0.push(mgt.connections.getAll({ fields: "name,id" }).then(connections => current.connections = connections));
  }

  if (dsc.rules.length > 0) {
    stage0.push(mgt.rules.getAll({ fields: "name,id" }).then(rules => current.rules = rules));
  }

  if (dsc.preconditions && dsc.preconditions.settings) {
    stage0.push(() => mgt.tenant.updateSettings({ flags: dsc.preconditions.settings }));
  }

  dsc.apis.forEach(api => {
    stage1.push(() => {
      var clones = _.filter(current.apis, { name: api.key });

      return Promise.all(clones.map(clone => mgt.resourceServers.delete({ id: clone.id })));
    });

    stage2.push(() => mgt.resourceServers.create(api).then(created => configured.apis[api.alias] = created));
  });

  dsc.clients.forEach(client => {
    let grants = client.grants;

    if (grants) {
      stage3.push(() => {
        grants = grants.map(grant => {
          grant.client_id = configured.clients[client.alias].client_id;
          grant.audience = grant.audience.key ? configured.apis[grant.audience.alias].identifier : grant.audience;

          return grant;
        });

        return Promise.all(grants.map(grant => mgt.clientGrants.create(grant).then(created => configured.clients[client.alias].grants.push(created))));
      });
    }

    delete client.grants;

    stage1.push(() => {
      var clones = _.filter(current.clients, { name: client.key });

      return Promise.all(clones.map(clone => mgt.clients.delete({ client_id: clone.client_id })));
    });

    stage2.push(() => mgt.clients.create(client).then(created => {
      configured.clients[client.alias] = created;
      configured.clients[client.alias].grants = [];
    }));
  });

  dsc.connections.forEach(connection => {
    stage1.push(() => {
      var clone = _.find(current.connections, { name: connection.key });

      return clone ? mgt.connections.delete({ id: clone.id }) : Promise.resolve(1);
    });

    stage3.push(() => {
      if (connection.enabled_clients) {
        connection.enabled_clients = connection.enabled_clients.map(client => client.key ? configured.clients[client.alias].client_id : client);
        connection.enabled_clients = _.union(connection.enabled_clients, [account.clientId]);
      }

      return mgt.connections.create(connection).then(created => configured.connections[connection.alias] = created);
    });
  });

  dsc.users.forEach(user => {
    stage4.push(() => {
      return mgt.users.create(user).then(created => configured.users[user.alias] = created);
    });
  });

  dsc.rules.forEach(rule => {
    stage1.push(() => {
      var clone = _.find(current.rules, { name: rule.key });

      return clone ? mgt.rules.delete({ id: clone.id }) : Promise.resolve(1);
    });

    stage4.push(() => {
      rule.script = mustache.render(rule.script, configured);

      return mgt.rules.create(rule).then(created => configured.rules[rule.alias] = created);
    });
  });

  if (dsc.email_provider) {
    stage4.push(() => mgt.emailProvider.update({}, dsc.email_provider).then(s => configured.email_provider = s));
  }

  if (dsc.settings) {
    stage4.push(() => {
      dsc.settings.default_audience = dsc.settings.default_audience.identifier || dsc.settings.default_audience;
      dsc.settings.default_directory = dsc.settings.default_directory.name || dsc.settings.default_directory;

      return mgt.tenant.updateSettings(dsc.settings).then(s => configured.settings = s);
    });
  }

  function run(stage) {
    return Promise.all(stage.map(fn => fn()));
  }

  return new Promise((resolve, reject) => {
    Promise.all(stage0)
      .then(() => run(stage1))
      .then(() => run(stage2))
      .then(() => run(stage3))
      .then(() => run(stage4))
      .then(() => resolve(configured))
      .catch((error) => reject(error));
  });
}

function cli() {
  const yargs = require("yargs");
  const concat = require("concat-stream");
  const jwt = require("jwt-decode");

  let argv = yargs
    .usage("Usage: $0 [options]")
    .env("DSC")
    .alias("y", "yaml")
    .nargs("y", 1)
    .describe("y", "The path to the YAML template file.")
    .alias("t", "target")
    .nargs("t", 1)
    .describe("t", "The target account (can either be a JWT token or a hostname).")
    .alias("d", "data")
    .nargs("d", 1)
    .describe("d", "The path to the JSON file containing the data used to transform the YAML template file.")
    .option("client")
    .describe("client", "The client identifier used to obtain a Management API token.")
    .option("secret")
    .describe("secret", "The client secret used to obtain a Management API token.")
    .demandOption(["y"])
    .config("config-file", "The path to the JSON configuration file used to argument parsing.")
    .help("h")
    .alias("h", "help")
    .epilog("copyright 2017")
    .argv;

  let template = fs.readFileSync(argv.yaml, "utf8");

  getData().then(data => getAccountInfo(data).then(account => run(template, data, account)));

  function getData() {
    if (!process.stdin.isTTY && !argv.data) {
      return new Promise((resolve, reject) => {
        process.stdin.setEncoding("utf8");

        process.stdin.pipe(concat(function (input) { resolve(JSON.parse(input)); }));
      });
    } else {
      let data = {};

      if (argv.data) {
        data = JSON.parse(fs.readFileSync(argv.data, "utf8"));
      }

      return Promise.resolve(data);
    }
  }

  function getAccountInfo(data) {
    if (argv.client || argv.secret) {
      return getAccessToken(argv.target, argv.client, argv.secret).then(token => {
        return { domain: argv.target, token: token, clientId: argv.client }
      });
    } else if (argv.target) {
      let token = argv.target;
      let claims = jwt(token);

      let domain = url.parse(claims.iss).hostname;
      let clientId = claims.sub.split("@")[0];

      return Promise.resolve({ domain: domain, token: token, clientId: clientId });
    } else if (data.dsc.domain && data.dsc.client_id && data.dsc.client_secret) {
      return getAccessToken(data.dsc.domain, data.dsc.client_id, data.dsc.client_secret).then(token => {
        return { domain: data.dsc.domain, token: token, clientId: data.dsc.client_id }
      });
    } else {
      return Promise.reject(new Error("Failed to obtain target account information."));
    }
  }

  function run(template, config, account) {
    execute(template, config, account).then(configured => console.log(JSON.stringify(configured, null, 2)));
  }
}

function getAccessToken(domain, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    request.post(`https://${domain}/oauth/token`)
      .send({
        audience: `https://${domain}/api/v2/`,
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
      .type('application/json')
      .end(function (err, response) {
        if (!err && response.statusCode == 200) {
          resolve(response.body.access_token);
        } else {
          reject(new Error("Failed to obtain an access token."));
        }
      });
  });
}
