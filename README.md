# Auth0 DSC Tooling

This repository provides a npm module/CLI that leverages the Auth0 Management API to automate the configuration of an account based on a given YAML template.

## Disclaimer

This is a developer tool meant for usage within test environments where any loss of data that can occur due to the misuse of the tool and/or bugs in the tool's logic will not cause any damage.

## Installation

Clone the repository and execute at your local working directory root:

```
npm install -g
```

## Usage

### Preconditions

In order to execute this tool you'll need to first ensure that a client credentials grant application is correctly setup in the target Auth0 account and that access to the Auth0 Management API was granted to this application with the inclusion of all the available scopes.

### Basic Scenario

Create a YAML configuration template and save it to a file:

```
clients:
  - &spa_client
    name: "node-express-lock-spa"
    callbacks:
      - "https://localhost:3000/"
    token_endpoint_auth_method: "none"
    app_type: "spa"
connections:
  - 
    name: "node-express-lock-spa-db"
    strategy: "auth0"
    enabled_clients:
      - *spa_client
```

Execute the following command:

```
dsc -y /path/template.yml -t [account].auth0.com --client [client_id] --secret [client_secret]
```

After execution finishes a client application and a database connection would be configured in the target account and with the specified settings.

The tool currently supports the creation of following entities:

* APIs - `apis`
* Client Applications - `clients`
* Connections - `connections`
* Users - `users`
* Rules - `rules`

Before creating each entity specified in the template, any already existing entity that **has the same name as the one configured on the input template will be deleted** so please take that under consideration before running the tool.

In addition, to the previously mentioned entities, the tool can also update:

* Email Provider Settings - `email_provider`
* Global Account Settings - `settings`

See the YAML Template Schema section for more information.

### Template Precompilation

Before parsing the YAML template the tool performs a placeholder substitution stage that you can use in order to have more flexibility. Any placeholder of the format `${{name}}` will be replaced by the value of the configuration property with the same `name`. The replacement supports nested properties and you can provide the configuration object to the tool either through:

* The `--config-file` option that represents the path to a JSON configuration file or
* through the `stdin` using shell pipes.

For example, assuming you have the file `config.json` containing `{ "system": { "port": 3000, "host": "localhost" } }` you could have the following template:

```
clients:
  - 
    name: "node-express-lock-spa"
    callbacks:
      - "https://${{system.host}}:${{system.port}}/"
```

and then execute the tool using:

```
dsc -y /path/template.yml -t [account].auth0.com --client [client_id] --secret [client_secret] --config-file config.json
```

or

```
cat config.json | dsc -y /path/template.yml -t [account].auth0.com --client [client_id] --secret [client_secret]
```

### Referencing Entities

Within certain properties of the YAML template you can reference other entities using YAML anchors and aliases notation. For example, within the `enabled_clients` collection of a given connection you can use a YAML aliase to reference a client application defined within the template itself.

The following template defines a client application and associates it the `&spa_client` anchor which is then used as an aliase `*spa_client` in the specified connection.

```
clients:
  - &spa_client
    name: "node-express-lock-spa"
connections:
  - 
    name: "node-express-lock-spa-db"
    strategy: "auth0"
    enabled_clients:
      - *spa_client
```

This type of construct allows to establish relationships between the created entities without actually knowing their final identifiers. This only works for predefined properties so check the YAML Template Schema section for more information.

### Referencing Generated Information

Some of the entities that can be created with this tool, like rules and custom database connections, include properties that represent code. In certain situations, you may want to have conditional logic within that code to react differently depending on the calling context.

The tool supports a second stage of placeholder replacement using the format `#{{name}}`. These placeholders are only replaced for certain properties so see the YAML Template Schema section for more information.

For example, you could use the newly generated identifier of a client application with a rule defined in the template itself by using:

```
clients:
  -
    name: "web_test"
    app_type: "regular_web"
rules:
  -
    name: "sample-rule"
    enabled: true
    script: |
      function (user, context, callback) {
        // TODO - implement your rule for client ID - #{{clients.default.client_id}}
        callback(null, user, context);
      }
```

The placeholder uses a three-part composite reference that starts by referencing the associated entity collection, then the alias of the specific entity and finally the property that you want to refer to. The alias part in this case does not refer to YAML aliases and instead is something you can either explictily control (using the `_alias` property) or rely on the automatic alias generation algorithm. See next section for more information.

### Entity Alias Generation

Each entity defined for collection properties like `clients` will have an alias assigned using the following rules:

1. If the entity template defines the `_alias` property then use it as the entity alias and stop processing further rules.
1. If the entity is the only one defined in the collection then use the alias `default` and stop processing further rules.
1. Otherwise, use the entity key property value as the alias.

For all entities except users, the entity key property is the `name`. For users, the key is the concatenation of the associated connection name, the `|` character and either the `email` or `username` property depending on which one is provided.

## YAML Template Schema

### Collection Nodes

For collection (`apis`, `clients`, `connections`, `users`, `rules`) nodes, with a few exceptions, the properties allowed for each entity are a direct mapping to the schema supported in the Management API when making create calls. The exceptions to this general rule are listed below:

* For the client entity you can use the collection property `grants` to specify any client grants that you want to create for that client. The properties available for each grant are the ones available in the API when creating a client grant except that the client identifier will be infered automatically.
* For the client grant entity within a client you can use YAML aliases in the `audience` property; the alias will be transformed automatically to the identifier of the API in question.
* For the connection entity you can use YAML aliases in the `enabled_clients` property; the alias will be transformed automatically to the client identifier of the client in question.
* For the user entity you can use YAML aliases in the `connection` property; the alias will be transformed automatically to the name of the connection in question.

Additionally, you can `#{{name}}` placeholder in the following properties:

* `rule.script`

### Email Provider Node

For the `email_provider` node the allowed schema is the one associated with the `PATCH` (Update the email provider) operation available in the Management API.

### Account Settings Node

For the `settings` node the allowed schema is the one associated with the `PATCH` (Update tenant settings) operation available in the Management API.

### Preconditions Node

The `preconditions` node allows to perform some operations before anything else. Currently it allows, to set any of the global account settings `flags`. For example:

```
preconditions:
  settings:
    enable_client_connections: false
    enable_apis_section: true
```

The previous section would ensure that before creating any other entities the two specified flags would be set to the provided values.

