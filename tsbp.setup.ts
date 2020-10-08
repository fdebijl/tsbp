import inquirer from 'inquirer';
import chalk from 'chalk';
import { ReplaceInFileConfig, replaceInFile } from 'replace-in-file';
import fs from 'fs';
import Path, { resolve } from 'path';
import { spawn } from 'child_process';

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

const assertDirectory = async (path: string): Promise<void> => {
  return new Promise((resolve) => {
    fs.stat(Path.resolve(path), (err) => {
      if (err) {
        fs.mkdirSync(Path.resolve(path), {
          recursive: true
        });

        setTimeout(() => {
          resolve();
        }, 500);
      } else {
        resolve();
      }
    })
  });
}

const applyProjectName = async (projectname: string, projecttype: ProjectType): Promise<void> => {
  return new Promise(async (resolve) => {
    switch (projecttype) {
      case ProjectType.Server: {
        const replaceOptions: ReplaceInFileConfig = {
          files: ['Dockerfile'],
          from: /%%PROJECTNAME%%/g,
          to: projectname
        }

        await replaceInFile(replaceOptions);
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
        fs.copyFileSync('boilerplate/aserver.dockerfile', 'Dockerfile');
        break;
      }
      case ProjectType.Cronjob: {
        fs.copyFileSync('boilerplate/acron.dockerfile', 'Dockerfile');
        fs.copyFileSync('boilerplate/PROJECTNAME-cron', 'PROJECTNAME-cron');
        break;
      }
    }

    setTimeout(() => {
      resolve();
    }, 500);
  });

};

const setupPackageJson = async (projectname: string, needsJasmine: boolean): Promise<void> => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  packageJson.name = projectname;
  delete packageJson.scripts.presetup;
  delete packageJson.scripts.setup;

  if (needsJasmine) {
    packageJson.scripts.test = 'jasmine-ts --config=jasmine.config.json';
  }

  fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
  return;
};

const setupJasmine = async (): Promise<void> => {
  return new Promise(async (resolve) => {
    console.log(chalk.green('Installing Jasmine, this may take a moment...'));

    fs.copyFileSync('boilerplate/jasmine.config.json', 'jasmine.config.json');
    await assertDirectory('test');
    fs.copyFileSync('boilerplate/index.spec.ts', Path.resolve('test/index.spec.ts'));

    // Add linting for Jasmine, courtesy of https://github.com/tlvince/eslint-plugin-jasmine
    const eslintrc = JSON.parse(fs.readFileSync('.eslintrc.json', 'utf8'));
    eslintrc.plugins = ['jasmine'];
    eslintrc.env.jasmine = true;
    eslintrc.extends.push('plugin:jasmine/recommended');
    fs.writeFileSync('.eslintrc.json', JSON.stringify(eslintrc, null, 2));

    // Exclude the test folder from typescript compilation
    const tsconfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
    tsconfig.compilerOptions.types = ['jasmine'];
    tsconfig.exclude = ['test/**/*.ts'];
    fs.writeFileSync('tsconfig.json', JSON.stringify(tsconfig, null, 2));

    // Install Jasmine dependencies with pinned versions (-E, aka --save-exact)
    const child = spawn('npm', ['install', '-D', '-E', 'jasmine', 'jasmine-spec-reporter', 'jasmine-ts', '@types/jasmine', 'eslint-plugin-jasmine'], {cwd: __dirname, shell: true});

    child.stderr.on('data', (data) => {
      // Uncomment the next line to pipe installation errors to the wizard screen
      // process.stdout.write(data);
    });

    child.on('exit', () => {
      resolve();
    });
  });
};

const ask = async (): Promise<string> => {
  return new Promise(async (resolve) => {
    inquirer.prompt([
      {
        type: 'confirm',
        name: 'needsrenovate',
        message: 'Does this project need Renovate? (Automatic Dependency Updates)'
      },
      {
        type: 'confirm',
        name: 'needsdocker',
        message: 'Does this project need Docker? (Containerisation)'
      },
      {
        type: 'confirm',
        name: 'needsjasmine',
        message: 'Does this project need Jasmine? (Unit Testing)'
      },
      {
        type: 'input',
        name: 'projectname',
        message: 'What is the name of this project? This value will be used in the Dockerfile, package.json and the cronjob (if applicable):'
      }
    ]).then(async (answers) => {
      const needsRenovate = ((answers as any).needsrenovate as boolean);
      const needsDocker = ((answers as any).needsdocker as boolean);
      const needsJasmine = ((answers as any).needsjasmine as boolean);
      const projectname = ((answers as any).projectname as string).toLowerCase();
      let projecttype: ProjectType = ProjectType.Server;

      if (!needsRenovate) {
        fs.unlinkSync('renovate.json');
      }

      await setupPackageJson(projectname, needsJasmine);

      if (!needsDocker) {
        if (needsJasmine) {
          await setupJasmine();
        }

        resolve(projectname);
        return;
      } else {
        inquirer.prompt([{
          type: 'list',
          name: 'projecttype',
          choices: ['Server', 'Cronjob'],
          message: `How should this project's container run? As a persistent server (i.e. run the main file until it crashes or exits) or a cronjob (i.e. a task that needs to be repeated every X minutes):`
        }]).then(async (inneranswers) => {
          projecttype = (inneranswers as any).projecttype as ProjectType;

          // Have to setup Jasmine here, rather than next to setupPackageJson, because the Jasmine setup takes a while and it would interrupt
          // the flow of questions.
          if (needsJasmine) {
            await setupJasmine();
          }

          await selectProjectType(projecttype);
          await applyProjectName(projectname, projecttype);
          resolve(projectname);
        });
      }
    });
  });
}

const init = (): void => {
  console.log(chalk.green(`Fdebijl's TypeScript BoilerPlate Setup`))
  ask().then((projectname) => {
    console.log(chalk.green(`\nSetup finished, npm will now remove all setup-related packages. You may have to manually remove the 'postsetup' script from package.json.`))

    deleteFolderRecursive(Path.resolve('boilerplate'));
    fs.writeFileSync('README.md', `# ${projectname || 'New TS Project'}\n\n*Enter a short description for the project here.*`);
  });
}

init();
