import chalk from 'chalk';
import clear from 'clear';
import figlet from 'figlet';
import AWS from 'aws-sdk';
import inquirer from 'inquirer';
import CLI from 'clui';
import { spawn } from 'child_process';
import SearchList from 'inquirer-search-list';
import download from 'download';
import tempfile from 'tempfile';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';


const argv = yargs(hideBin(process.argv))
  .option('mfa', {default: true, type: "boolean", description: "Use MFA authentication"})  
  .option('cluster', {type: "string", description: "ECS cluster name or ARN"})
  .option('test', {default: true, type: "boolean", description: "Run check-ecs-exec to validate your configuration"})
  .help().argv

clear();
inquirer.registerPrompt('search-list', SearchList);

function askMFA() {
  const questions = [
    {
      name: 'mfaCode',
      type: 'input',
      message: 'Enter MFA code (leave empty if not using MFA):',
    },
  ];
  return inquirer.prompt(questions);
}

function askCluster(clusterArns) {
  const clusterNames = clusterArns.map(ca => clusterFriendlyName(ca));
  if(clusterArns.includes(argv.cluster)) {
    return {cluster: clusterArns[clusterArns.indexOf(argv.cluster)]}
  }
  if(clusterNames.includes(argv.cluster)) {
    return {cluster: clusterArns[clusterNames.indexOf(argv.cluster)]}
  }
  const questions = [
    {
      name: 'cluster',
      type: 'search-list',
      message: 'Select cluster:',
      choices: clusterNames,
    },
  ];
  return inquirer.prompt(questions);
}

function taskDefFriendlyName(taskDefinitionArn) {
  return taskDefinitionArn.replace(/^(.+)task-definition\//, '');
}
function clusterFriendlyName(clusterArn) {
  return clusterArn.replace(/^(.+)cluster\//, '');
}

async function askTasks(tasks) {
  const questions = [
    {
      name: 'task',
      type: 'search-list',
      message: 'Select task:',
      choices: tasks.map(t => `${taskDefFriendlyName(t.taskDefinitionArn)} - (${t.launchType})`),
    },
  ];
  const answer = await inquirer.prompt(questions);
  return {...answer, index: questions[0].choices.indexOf(answer.task)}
}

async function askContainers(containerNames) {
  const questions = [
    {
      name: 'container',
      type: 'search-list',
      message: 'Select container:',
      choices: containerNames,
    },
  ];
  return inquirer.prompt(questions);
}

async function askShell() {
  const questions = [
    {
      name: 'shell',
      type: 'search-list',
      message: 'Select shell:',
      choices: ["/bin/bash", "/bin/sh"],
    },
  ];
  return inquirer.prompt(questions);
}

async function mfaTokens(mfaToken) {
  try {
    const iam = new AWS.IAM();
    const devices = await iam.listMFADevices().promise();
    if(devices.MFADevices.length === 0) {
      chalk.red("No MFA devices found");
      throw new Error("No MFA devices found")
    }
    const {SerialNumber: serialNumber} = devices.MFADevices[0];
    const sts = new AWS.STS();
    const token = await sts.getSessionToken({DurationSeconds: 3600, SerialNumber: serialNumber, TokenCode: mfaToken}).promise();
    AWS.config.credentials = token.Credentials;
  } catch(e) {
    console.log(chalk.red(`MFA failed: ${e.message}`));
    throw new Error("MFA failed")
  }
}

async function listClusters() {
  const status = new CLI.Spinner('Fetching clusters, please wait...');
  try {
    status.start();
    const ecs = new AWS.ECS();
    const {clusterArns} = await ecs.listClusters().promise();
    return clusterArns;
  } finally {
    status.stop();
  }  
}

async function listTasks(cluster) {
  const status = new CLI.Spinner('Fetching tasks, please wait...');
  try {
    status.start();
    const ecs = new AWS.ECS();
    const {taskArns} = await ecs.listTasks({cluster, desiredStatus: 'RUNNING'}).promise();
    const {tasks} = await ecs.describeTasks({cluster, tasks:taskArns}).promise();
    return tasks.filter(t => t.enableExecuteCommand)
  } finally {
    status.stop();
  }  
}

function findExecuteCommandContainer(task) {
  return task.containers.filter(
    c => ('managedAgents' in c) && c.managedAgents.find(m => m.name === 'ExecuteCommandAgent')
  ).map(c => c.name)
}

async function testConfig(cluster, taskArn) {
  let execFolder;
  let execPath;
  try {
    const testUrl = "https://raw.githubusercontent.com/aws-containers/amazon-ecs-exec-checker/main/check-ecs-exec.sh";
    execFolder = tempfile();
    await download(testUrl, execFolder);
    execPath = path.join(execFolder, "check-ecs-exec.sh");
    fs.chmodSync(execPath, "755");
    await spawnAwsScript(
        execPath,
        [cluster, taskArn]
      )
  } finally {
    if(fs.existsSync(execPath)) {
      fs.rmdirSync(execFolder, { recursive: true, force: true });
    }
  }
}

function spawnAwsScript(cmd, args) {
  return new Promise((resolve, reject) => {
    const shell = spawn(
      cmd,
      args, 
      { 
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: AWS.config.credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: AWS.config.credentials.secretAccessKey,
        },
        stdio: 'inherit',
        stderr: 'inherit',
      });
    shell.on('close', (...args) => {
      console.error(...args);
      resolve(...args);
    })
    shell.on('error', (err) => {
      console.error(err);
      reject(err);
    })
  })
}

console.log(
  chalk.yellow(
    figlet.textSync('ECS-Exec', { horizontalLayout: 'full' })
  )
);

const run = async () => {
  try {
    const {mfa = true} = argv;
    if(mfa) {
      const {mfaCode} = await askMFA();
      if(mfaCode) {
        await mfaTokens(mfaCode);
      }
    }
    const clusterArns = await listClusters();
    const {cluster} = await askCluster(clusterArns);
    const tasks = await listTasks(cluster);
    const res = await askTasks(tasks);
    const selectedTask = tasks[res.index];

    const {test = true} = argv;
    if(test) {
      await testConfig(cluster, selectedTask.taskArn);
    }
    const containers = findExecuteCommandContainer(selectedTask);
    const containerName = containers.length > 1 ? (await askContainers(containers)).container : containers[0];
    const {shell} = await askShell()
    await spawnAwsScript(
      'aws',
      [
        "ecs", "execute-command", 
        "--cluster", cluster, "--task", selectedTask.taskArn, "--container", containerName, 
        "--interactive", 
        "--command", `"${shell}"`
      ],
    )
  } catch(e) {
    console.log(chalk.red(e.message));
    return 1;
  }
};
// https://www.sitepoint.com/javascript-command-line-interface-cli-node-js/
run();