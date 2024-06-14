const fs = require('fs');
const fse = require('fs-extra');
const { join } = require('path');
const { execSync } = require('child_process');

let argv;
const port = 10004;

function getPortMock() {
  return 3000;
}
const nodeVersion = process.versions.node;
const nodeVersionMajor = Number(nodeVersion.split('.')[0]);
const { getPort } = nodeVersionMajor >= 14 ? require('get-port-please') : { getPort: getPortMock };

const isWindows = process.platform === 'win32';
const regexEscape = isWindows ? '\r\n' : '\n';

let grafanaPort;
let serverPort;

function createRegexWithEscape(string) {
  return new RegExp(string.replace('\r\n', regexEscape));
}

function UpdateEnvFile() {
  const envFile = join(__dirname, '../../.env');
  if (fs.existsSync(envFile) && !argv.force) return console.log('Env file already exists, use --force to overwrite it');

  const exampleEnvFilePath = join(__dirname, '../../example.env');
  let exampleEnvText = fs.readFileSync(exampleEnvFilePath, 'utf8');
  exampleEnvText = exampleEnvText
    .replace('GRAFANA_PORT=3000', `GRAFANA_PORT=${grafanaPort}`)
    .replace('COMPOSE_PROJECT_NAME=screeps-grafana', `COMPOSE_PROJECT_NAME=screeps-grafana-3000`)
    .replace('COMPOSE_FILE=./docker-compose.yml', `COMPOSE_FILE=${join(__dirname, '../../docker-compose.yml')}`);
  if (serverPort) exampleEnvText = exampleEnvText.replace('SERVER_PORT=21025', `SERVER_PORT=${serverPort}`);

  fs.writeFileSync(envFile, exampleEnvText);
  console.log('Env file created');
}

async function UpdateDockerComposeFile() {
  const dockerComposeFile = join(__dirname, '../../docker-compose.yml');
  if (fs.existsSync(dockerComposeFile) && !argv.force) return console.log('Docker-compose file already exists, use --force to overwrite it');
  const { relayPort } = argv;

  const exampleDockerComposeFile = join(__dirname, '../../docker-compose.example.yml');
  let exampleDockerComposeText = fs.readFileSync(exampleDockerComposeFile, 'utf8');
  exampleDockerComposeText = exampleDockerComposeText
    .replace('3000:3000', `${grafanaPort}:${grafanaPort}`);
  exampleDockerComposeText = exampleDockerComposeText.replace('http://localhost:3000/login', `http://localhost:${grafanaPort}/login`);

  if (relayPort) exampleDockerComposeText = exampleDockerComposeText.replace('2003:2003', `${relayPort}:2003`);
  else {
    exampleDockerComposeText = exampleDockerComposeText.replace(createRegexWithEscape('ports:\r\n      - 2003:2003'), '');
  }
  if (serverPort) {
    exampleDockerComposeText = exampleDockerComposeText
      .replace('http://localhost:21025/web', `http://localhost:${serverPort}/web`)
      .replace('SERVER_PORT: 21025', `SERVER_PORT: ${serverPort}`);
  }
  if (argv.includePushStatusApi) exampleDockerComposeText = exampleDockerComposeText.replace('INCLUDE_PUSH_STATUS_API=false', `INCLUDE_PUSH_STATUS_API=true${regexEscape}    ports:${regexEscape}        - ${port}:${port}`);
  if (argv.prefix) exampleDockerComposeText = exampleDockerComposeText.replace('PREFIX=', `PREFIX=${argv.prefix}`);


  fs.writeFileSync(dockerComposeFile, exampleDockerComposeText);
  console.log('Docker-compose file created');
}

function UpdateUsersFile() {
  const usersFile = join(__dirname, '../../users.json');
  if (fs.existsSync(usersFile) && !argv.force) return console.log('Users file already exists, use --force to overwrite it');

  const exampleUsersFilePath = join(__dirname, '../../users.example.json');
  const exampleUsersText = fs.readFileSync(exampleUsersFilePath, 'utf8');
  fs.writeFileSync(usersFile, exampleUsersText);
  console.log('Users file created');
}

function UpdateGrafanaConfigFolder() {
  const grafanaConfigFolder = join(__dirname, '../../grafanaConfig');
  if (fs.existsSync(grafanaConfigFolder) && !argv.force) return console.log('Grafana config folder already exists, use --force to overwrite it');

  fse.copySync(join(__dirname, '../../grafanaConfig.example'), grafanaConfigFolder);
  const grafanaIniFile = join(grafanaConfigFolder, './grafana/grafana.ini');
  let grafanaIniText = fs.readFileSync(grafanaIniFile, 'utf8');

  const { username } = argv;
  const { password } = argv;
  const { enableAnonymousAccess } = argv;
  if (username) grafanaIniText = grafanaIniText.replace(/admin_user = (.*)/, `admin_user = ${username}`);
  if (password) grafanaIniText = grafanaIniText.replace(/admin_password = (.*)/, `admin_password = ${password}`);
  if (argv.grafanaDomain) {
    grafanaIniText = grafanaIniText.replace('domain = localhost', `domain = ${argv.grafanaDomain}`);
    grafanaIniText = grafanaIniText.replace('from_address = admin@localhost', `from_address = admin@${argv.grafanaDomain}`);
  }
  if (grafanaPort) grafanaIniText = grafanaIniText.replace('http_port = 3000', `http_port = ${grafanaPort}`);
  grafanaIniText = grafanaIniText.replace(createRegexWithEscape('enable anonymous access\r\nenabled = (.*)'), `enable anonymous access${regexEscape}enabled = ${enableAnonymousAccess}`);
  fs.writeFileSync(grafanaIniFile, grafanaIniText);

  // This can just be set manually in the config folder.
  /*
  const storageSchemasFile = join(grafanaConfigFolder, './go-carbon/storage-schemas.conf');
  let storageSchemasText = fs.readFileSync(storageSchemasFile, 'utf8');
  const { defaultRetention } = argv;

  if (defaultRetention) storageSchemasText = storageSchemasText.replace(createRegexWithEscape('pattern = .*\r\nretentions = (.*)'), `pattern = .*${regexEscape}retentions = ${defaultRetention}`);
  fs.writeFileSync(storageSchemasFile, storageSchemasText);

  */

  console.log('Grafana config folder created');
}

function resetFolders() {
  const carbonStoragePath = join(__dirname, '../../go-carbon-storage');
  let carbonStorageExists = fs.existsSync(carbonStoragePath);
  if (carbonStorageExists && argv.removeWhisper) {
    fs.rmdirSync(carbonStoragePath, { recursive: true });
    carbonStorageExists = false;
  }
  if (!carbonStorageExists) {
    fs.mkdirSync(carbonStoragePath, { recursive: true });
  }

  const logsPath = join(__dirname, '../../logs');
  let logsExist = fs.existsSync(logsPath);
  if (logsExist && argv.deleteLogs) {
    fs.rmdirSync(logsPath, { recursive: true });
    logsExist = false;
  }
  if (!logsExist) fs.mkdirSync(logsPath, { recursive: true });
}

async function Setup(mArgv) {
  argv = mArgv || {};
  if (argv.grafanaPort) grafanaPort = argv.grafanaPort;
  else {
    grafanaPort = 3000
  }

  argv.grafanaPort = grafanaPort;
  serverPort = argv.serverPort;

  UpdateUsersFile();
  UpdateEnvFile();
  await UpdateDockerComposeFile();
  UpdateGrafanaConfigFolder();
}

if (process.argv[2] === 'setup') Setup();

module.exports = Setup;

module.exports.commands = async function Commands(grafanaApiUrl) {
  console.log(`\r\nGrafana API URL: ${grafanaApiUrl}${serverPort ? `, serverPort: ${serverPort}`
    : ''}`);

  const commands = [
    { command: `docker-compose down ${argv.removeVolumes ? '--volumes' : ''} --remove-orphans`, name: 'docker-compose down' },
    { command: 'docker-compose build --no-cache', name: 'docker-compose build' },
    { command: 'docker-compose up -d', name: 'docker-compose up' },
  ];

  console.log('\r\nExecuting start commands:');
  for (let i = 0; i < commands.length; i += 1) {
    const commandInfo = commands[i];
    try {
      console.log(`Running command ${commandInfo.name}`);
      execSync(commandInfo.command, { stdio: argv.debug ? 'inherit' : 'ignore' });
      if (commandInfo.name.startsWith('docker-compose down')) resetFolders();
    } catch (error) {
      console.log(`Command ${commandInfo.name} errored`, error);
      console.log('Stopping setup');
      process.exit(1);
    }
  }
};
