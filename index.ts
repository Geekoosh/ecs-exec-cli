import chalk from "chalk";
import clear from "clear";
import figlet from "figlet";
import AWS from "aws-sdk";
import inquirer from "inquirer";
import CLI from "clui";
import { spawn } from "child_process";
import SearchList from "inquirer-search-list";
import download from "download";
import tempfile from "tempfile";
import fs from "fs";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("mfa", {
    default: true,
    type: "boolean",
    description: "Use MFA authentication",
  })
  .option("cluster", { type: "string", description: "ECS cluster name or ARN" })
  .option("test", {
    default: true,
    type: "boolean",
    description: "Run check-ecs-exec to validate your configuration",
  })
  .help().argv as { mfa: boolean; cluster?: string; test: boolean };

clear();
inquirer.registerPrompt("search-list", SearchList);

function askMFA() {
  const questions = [
    {
      name: "mfaCode",
      type: "input",
      message: "Enter MFA code (leave empty if not using MFA):",
    },
  ];
  return inquirer.prompt(questions);
}

function askCluster(clusterArns: AWS.ECS.StringList) {
  const clusterNames = clusterArns.map((ca) => clusterFriendlyName(ca));
  if (argv.cluster && clusterArns.includes(argv.cluster)) {
    return { cluster: clusterArns[clusterArns.indexOf(argv.cluster)] };
  }
  if (argv.cluster && clusterNames.includes(argv.cluster)) {
    return { cluster: clusterArns[clusterNames.indexOf(argv.cluster)] };
  }
  const questions = [
    {
      name: "cluster",
      type: "search-list",
      message: "Select cluster:",
      choices: clusterNames,
    },
  ];
  return inquirer.prompt(questions);
}

function taskDefFriendlyName(taskDefinitionArn: string) {
  return taskDefinitionArn.replace(/^(.+)task-definition\//, "");
}
function clusterFriendlyName(clusterArn: string) {
  return clusterArn.replace(/^(.+)cluster\//, "");
}

async function askTasks(tasks: AWS.ECS.Task[]) {
  const questions = [
    {
      name: "task",
      type: "search-list",
      message: "Select task:",
      choices: tasks
        .map((t) =>
          t.taskDefinitionArn
            ? `${taskDefFriendlyName(t.taskDefinitionArn)} - (${t.launchType})`
            : undefined
        )
        .filter((s) => !!s),
    },
  ];
  const answer = await inquirer.prompt(questions);
  return { ...answer, index: questions[0].choices.indexOf(answer.task) };
}

async function askContainers(containerNames: string[]) {
  const questions = [
    {
      name: "container",
      type: "search-list",
      message: "Select container:",
      choices: containerNames,
    },
  ];
  return inquirer.prompt(questions);
}

async function askShell() {
  const questions = [
    {
      name: "shell",
      type: "search-list",
      message: "Select shell:",
      choices: ["/bin/bash", "/bin/sh"],
    },
  ];
  return inquirer.prompt(questions);
}

async function mfaTokens(mfaToken: string) {
  try {
    const iam = new AWS.IAM();
    const devices = await iam.listMFADevices().promise();
    if (devices.MFADevices.length === 0) {
      chalk.red("No MFA devices found");
      throw new Error("No MFA devices found");
    }
    const { SerialNumber: serialNumber } = devices.MFADevices[0];
    const sts = new AWS.STS();
    const token = await sts
      .getSessionToken({
        DurationSeconds: 3600,
        SerialNumber: serialNumber,
        TokenCode: mfaToken,
      })
      .promise();
    const { Credentials } = token;
    if (!Credentials) {
      throw new Error("Credentials not generated");
    }
    AWS.config.credentials = {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
    };
  } catch (e) {
    if (e instanceof Error) {
      console.log(chalk.red(`MFA failed: ${e.message}`));
    }
    throw new Error("MFA failed");
  }
}

async function listClusters() {
  const status = new CLI.Spinner("Fetching clusters, please wait...");
  try {
    status.start();
    const ecs = new AWS.ECS();
    const { clusterArns } = await ecs.listClusters().promise();
    return clusterArns;
  } finally {
    status.stop();
  }
}

async function listTasks(cluster: string) {
  const status = new CLI.Spinner("Fetching tasks, please wait...");
  try {
    status.start();
    const ecs = new AWS.ECS();
    const { taskArns } = await ecs
      .listTasks({ cluster, desiredStatus: "RUNNING" })
      .promise();
    if (!taskArns) {
      return undefined;
    }
    const { tasks } = await ecs
      .describeTasks({ cluster, tasks: taskArns })
      .promise();
    if (!tasks) {
      return undefined;
    }
    return tasks.filter((t) => t.enableExecuteCommand);
  } finally {
    status.stop();
  }
}

function findExecuteCommandContainer(task: AWS.ECS.Task) {
  if (!task.containers) {
    return [];
  }
  return task.containers
    .filter(
      (c) =>
        c.managedAgents &&
        c.managedAgents.find((m) => m.name === "ExecuteCommandAgent")
    )
    .map((c) => c.name || "container");
}

async function testConfig(cluster: string, taskArn: string) {
  let execFolder: string | undefined = undefined;
  let execPath: string | undefined = undefined;
  try {
    const testUrl =
      "https://raw.githubusercontent.com/aws-containers/amazon-ecs-exec-checker/main/check-ecs-exec.sh";
    execFolder = tempfile();
    await download(testUrl, execFolder);
    execPath = path.join(execFolder, "check-ecs-exec.sh");
    fs.chmodSync(execPath, "755");
    await spawnAwsScript(execPath, [cluster, taskArn]);
  } finally {
    if (execFolder && execPath && fs.existsSync(execPath)) {
      fs.rmdirSync(execFolder, { recursive: true });
    }
  }
}

function spawnAwsScript(cmd: string, args: string[]) {
  return new Promise((resolve, reject) => {
    const { credentials } = AWS.config;
    if(!credentials) {
      throw new Error("No AWS credentials to run the script")
    }
    const shell = spawn(cmd, args, {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      },
      stdio: "inherit",
    });
    shell.on("close", (...args: unknown[]) => {
      console.error(...args);
      resolve(args);
    });
    shell.on("error", (err: Error) => {
      console.error(err);
      reject(err);
    });
  });
}

console.log(
  chalk.yellow(figlet.textSync("ECS-Exec", { horizontalLayout: "full" }))
);

const run = async () => {
  try {
    const { mfa = true } = argv;
    if (mfa) {
      const { mfaCode } = await askMFA();
      if (mfaCode) {
        await mfaTokens(mfaCode);
      }
    }
    const clusterArns = await listClusters();
    if (!clusterArns) {
      throw new Error("No clusters found");
    }
    const { cluster } = await askCluster(clusterArns);
    const tasks = await listTasks(cluster);
    if (!tasks) {
      throw new Error("No tasks found in cluster");
    }
    const res = await askTasks(tasks);
    const selectedTask = tasks[res.index];
    if (!selectedTask.taskArn) {
      throw new Error("Selected task has no ARN")
    }
    const { test = true } = argv;
    if (test) {
      await testConfig(cluster, selectedTask.taskArn);
    }
    const containers = findExecuteCommandContainer(selectedTask);
    const containerName =
      containers.length > 1
        ? (await askContainers(containers)).container
        : containers[0];
    const { shell } = await askShell();
    await spawnAwsScript("aws", [
      "ecs",
      "execute-command",
      "--cluster",
      cluster,
      "--task",
      selectedTask.taskArn,
      "--container",
      containerName,
      "--interactive",
      "--command",
      `"${shell}"`,
    ]);
  } catch (e) {
    if (e instanceof Error) {
      console.log(chalk.red(e.message));
    }
    return 1;
  }
};
// https://www.sitepoint.com/javascript-command-line-interface-cli-node-js/
run();
