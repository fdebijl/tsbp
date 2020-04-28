import inquirer from 'inquirer';
import chalk from 'chalk';
import { ReplaceInFileConfig, replaceInFile } from 'replace-in-file';
import fs from 'fs';
import Path from 'path';

enum ProjectType {
  'Server' = 'Server',
  'Cronjob' = 'Cronjob'
}

const deleteFolderRecursive = (path: string): void => {
  if (fs.existsSync(path)) {
    fs.readdirSync(path).forEach((file) => {
      const curPath = Path.join(path, file);
      if (fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
};

const applyProjectName = async (projectname: string, projecttype: ProjectType): Promise<void> => {
  return new Promise(async (resolve) => {
    switch (projecttype) {
      case ProjectType.Server: {
        const replaceOptions: ReplaceInFileConfig = {
          files: ['Dockerfile'],
          from: /%%PROJECTNAME%%/g,
          to: projectname
        }

        const results = await replaceInFile(replaceOptions);
        break;
      }
      case ProjectType.Cronjob: {
        const replaceOptions: ReplaceInFileConfig = {
          files: ['Dockerfile', 'PROJECTNAME-cron'],
          from: /%%PROJECTNAME%%/g,
          to: projectname
        }

        await replaceInFile(replaceOptions);

        fs.renameSync('PROJECTNAME-cron', `${projectname}-cron`);
        break;
      }
    }

    setTimeout(() => {
      resolve();
    }, 500);
  });
};

const selectProjectType = async (projecttype: ProjectType): Promise<void> => {
  return new Promise((resolve) => {
    switch (projecttype) {
      case ProjectType.Server: {
        fs.copyFileSync('boilerplate/Dockerfile-server', 'Dockerfile');
        break;
      }
      case ProjectType.Cronjob: {
        fs.copyFileSync('boilerplate/Dockerfile-cron', 'Dockerfile');
        fs.copyFileSync('boilerplate/PROJECTNAME-server', 'Dockerfile');
        break;
      }
    }

    setTimeout(() => {
      resolve();
    }, 500);
  });

};

const setupPackageJson = async (projectname: string): Promise<void> => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  packageJson.name = projectname;
  delete packageJson.scripts.setup;
  fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
  return;
};

const ask = async (): Promise<string> => {
  return new Promise(async (resolve) => {
    inquirer.prompt([
      {
        type: 'confirm',
        name: 'needsrenovate',
        message: 'Does this project need Renovate?'
      },
      {
        type: 'confirm',
        name: 'needsdocker',
        message: 'Does this project need Docker?'
      },
      {
        type: 'input',
        name: 'projectname',
        message: 'What is the name of this project? This value will be used in the Dockerfile, package.json and the cronjob (if applicable):'
      },
      {
        type: 'list',
        name: 'projecttype',
        choices: ['Server', 'Cronjob'],
        message: `How should this project run? As a persistent server (i.e. run the main file until it crashes or exits) or a cronjob (i.e. a task that needs to be repeated every X minutes):`
      }
    ]).then(async (answers) => {
      const needsRenovate = ((answers as any).needsrenovate as boolean)
      const needsDocker = ((answers as any).needsdocker as boolean)
      const projectname = ((answers as any).projectname as string).toLowerCase();
      const projecttype = (answers as any).projecttype as ProjectType;

      if (!needsRenovate) {
        fs.unlinkSync('renovate.json');
      }

      await setupPackageJson(projectname);

      if (!needsDocker) {
        console.log(chalk.green('Since Docker is not needed, you can simply start developing with the current setup!'));
        resolve(projectname);
        return;
      }

      await selectProjectType(projecttype);
      await applyProjectName(projectname, projecttype);
      resolve(projectname);
    });
  });
}

const init = (): void => {
  console.log(chalk.green(`Fdebijl's TypeScript BoilerPlate Setup`))
  ask().then((projectname) => {
    console.log(chalk.green(`Setup finished, npm will now remove all setup-related packages. You may have to manually remove the 'postsetup' script from package.json.`))
    deleteFolderRecursive(Path.resolve('boilerplate'));
    fs.writeFileSync('README.md', `# ${projectname || 'New TS Project'}\n\n*Enter a short description for the project here.*`);
    process.exit(0);
  });
}

init();
