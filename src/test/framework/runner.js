'use strict';
var _ = require('lodash');
var fs = require('fs');
var argv = require('minimist')(process.argv);
var istanbul = require('istanbul');
var request = require('request');
var mkdirp = require('mkdirp');

require('dotenv').load();

var promise_utils = require('../../util/promise_utils');
var P = require('../../util/promise');
var ops = require('../system_tests/basic_server_ops');
var api = require('../../api');

var COVERAGE_DIR = './report/cov';
var REPORT_PATH = COVERAGE_DIR + '/regression_report.log';

function TestRunner(argv) {
    this._version = argv.GIT_VERSION;
    this._argv = argv;
    this._error = false;
    if (argv.FLOW_FILE) {
        this._steps = require(argv.FLOW_FILE);
    } else {
        this._steps = require(process.cwd() + '/src/test/framework/flow.js');
    }
}

/**************************
 *   Common Functionality
 **************************/
TestRunner.prototype.wait_for_server_to_start = function(max_seconds_to_wait) {
    var isNotListening = true;
    var MAX_RETRIES = max_seconds_to_wait;
    var wait_counter = 1;
    //wait up to 10 seconds
    return promise_utils.pwhile(
            function() {
                return isNotListening;
            },
            function() {
                return P.ninvoke(request, 'get', {
                    url: 'http://127.0.0.1:8080/',
                    rejectUnauthorized: false,
                }).spread(function(res, body) {
                    console.log('server started after ' + wait_counter + ' seconds');
                    isNotListening = false;
                }, function(err) {
                    console.log('waiting for server to start');
                    wait_counter += 1;
                    if (wait_counter >= MAX_RETRIES) {
                        console.Error('Too many retries after restart server');
                        throw new Error('Too many retries');
                    }
                    return P.delay(1000);
                });
                //one more delay for reconnection of other processes
            }).delay(2000)
        .then(function() {
            return;
        });
};

TestRunner.prototype.restore_db_defaults = function() {
    var self = this;

    return promise_utils.promised_exec(
            'mongo nbcore /root/node_modules/noobaa-core/src/test/system_tests/mongodb_defaults.js')
        .fail(function(err) {
            console.warn('failed on mongodb_defaults', err);
            throw new Error('Failed pn mongodb reset');
        })
        .then(function() {
            return promise_utils.promised_exec('supervisorctl restart webserver');
        })
        .then(function() {
            return self.wait_for_server_to_start(30);
        })
        .fail(function(err) {
            console.log('Failed restarting webserver');
            throw new Error('Failed restarting webserver');
        });
};

/**************************
 *   Flow Control
 **************************/

TestRunner.prototype.init_run = function() {
    var self = this;
    //Clean previous run results
    console.log('Clearing previous test run results');
    if (!fs.existsSync(COVERAGE_DIR)) {
        P.nfcall(mkdirp, COVERAGE_DIR);
    }

    self._rpc = api.new_rpc();
    self._client = self._rpc.new_client();
    self._bg_client = self._rpc.new_client({
        domain: 'bg'
    });

    return P.fcall(function() {
            var auth_params = {
                email: 'demo@noobaa.com',
                password: 'DeMo',
                system: 'demo'
            };
            return self._client.create_auth_token(auth_params);
        })
        .then(function() {
            return promise_utils.promised_exec('rm -rf ' + COVERAGE_DIR + '/*');
        })
        .fail(function(err) {
            console.error('Failed cleaning ', COVERAGE_DIR, 'from previous run results', err);
            throw new Error('Failed cleaning dir');
        })
        .then(function() {
            return promise_utils.promised_exec('rm -rf /root/node_modules/noobaa-core/coverage/*');
        })
        .fail(function(err) {
            console.error('Failed cleaning istanbul data from previous run results', err);
            throw new Error('Failed cleaning istanbul data');
        })
        .then(function() {
            //Restart services to hook require instanbul
            return self._restart_services(true);
        })
        .then(function() {
            fs.appendFileSync(REPORT_PATH, 'Init Test Run for version ' + self._version + '\n');
        });
};

TestRunner.prototype.complete_run = function() {
    //Take coverage output and report and pack them
    var self = this;
    var dst = '/tmp/res_' + this._version + '.tgz';

    return this._write_coverage()
        .fail(function(err) {
            console.error('Failed writing coverage for test runs', err);
            throw new Error('Failed writing coverage for test runs');
        })
        .then(function() {
            return promise_utils.promised_exec('tar --warning=no-file-changed -zcvf ' + dst + ' ' + COVERAGE_DIR + '/*');
        })
        .fail(function(err) {
            console.error('Failed archiving test runs', err);
            throw new Error('Failed archiving test runs');
        })
        .then(function() {
            return self._restart_services(false);
        })
        .then(function() {
            return self.wait_for_server_to_start(30);
        })
        .then(function() {
            console.log('Uploading results file');
            //Save package on current NooBaa system
            return ops.upload_file('127.0.0.1', dst, 'files', 'report_' + self._version + '.tgz');
        })
        .fail(function(err) {
            console.log('Failed restarting webserver');
            throw new Error('Failed restarting webserver');
        });
};

TestRunner.prototype.run_tests = function() {
    var self = this;

    return P.each(self._steps, function(current_step) {
            return P.when(self._print_curent_step(current_step))
                .then(function(step_res) {
                    return P.when(self._run_current_step(current_step, step_res));
                })
                .then(function(step_res) {
                    fs.appendFileSync(REPORT_PATH, step_res + '\n');
                    return;
                });
        })
        .then(function() {
            fs.appendFileSync(REPORT_PATH, 'All steps done\n');
            return;
        })
        .fail(function(error) {
            fs.appendFileSync(REPORT_PATH, 'Stopping tests\n', error);
            return;
        });
};

TestRunner.prototype.print_conclusion = function() {
    console.log(fs.readFileSync('./report/cov/regression_report.log').toString());
};

TestRunner.prototype._print_curent_step = function(current_step) {
    var step_res;
    var title;
    return P.fcall(function() {
        if (current_step.common) {
            title = 'Performing ' + current_step.name;
            step_res = current_step.name;
        } else if (current_step.action) {
            title = 'Running Action ' + current_step.name;
            step_res = current_step.name;
        } else if (current_step.lib_test) {
            title = 'Running Library Test ' + current_step.name;
            step_res = current_step.name;
        } else {
            title = 'Running Unamed ' + current_step.action;
            step_res = current_step.action;
        }
        fs.appendFileSync(REPORT_PATH, title + '\n');
        return step_res;
    });
};

TestRunner.prototype._run_current_step = function(current_step, step_res) {
    var self = this;
    if (!current_step.action &&
        !current_step.common &&
        !current_step.lib_test) {
        step_res = '        No Action Defined!!!';
        return;
    } else {
        if (current_step.common) {
            var ts = new Date();
            return P.invoke(self, current_step.common)
                .then(function() {
                    return step_res + ' - Successeful ( took ' +
                        ((new Date() - ts) / 1000) + 's )';
                    //return step_res;
                });
        } else if (current_step.action) {
            return self._run_action(current_step, step_res);
        } else if (current_step.lib_test) {
            return self._run_lib_test(current_step, step_res);
        } else {
            throw new Error('Undefined step');
        }
    }
};

TestRunner.prototype._run_action = function(current_step, step_res) {
    var self = this;
    var ts = new Date();
    //Build execution context from action and arguments
    var command = current_step.action;
    if (current_step.params && current_step.params.length > 0) {
        _.each(current_step.params, function(p) {
            if (p.arg) {
                command += ' ' + p.arg;
            } else if (p.input_arg) {
                if (self._argv[p.input_arg]) {
                    command += ' ' + self._argv[p.input_arg];
                } else {
                    fs.appendFileSync(REPORT_PATH, 'No argument recieved for ' + p.input_args + '\n');
                }
            }
        });
    }

    return promise_utils.promised_exec(command)
        .then(function(res) {
            step_res = '        ' + step_res + ' - Successeful ( took ' +
                ((new Date() - ts) / 1000) + 's )';
            return step_res;
        })
        .fail(function(res) {
            self._error = true;
            if (current_step.blocking) {
                fs.appendFileSync(REPORT_PATH, step_res + ' ' + res + '\n');
                throw new Error('Blocking action failed');
            } else {
                step_res = '        ' + step_res + ' - Failed with \n' +
                    '------------------------------\n' +
                    res +
                    '------------------------------   ' +
                    '( took ' + ((new Date() - ts) / 1000) + 's )';
            }
            return step_res;
        });
};

TestRunner.prototype._run_lib_test = function(current_step, step_res) {
    var self = this;
    var ts = new Date();

    var test = require(process.cwd() + current_step.lib_test);
    return P.when(test.run_test())
        .then(function(res) {
            step_res = '        ' + step_res + ' - Successeful ( took ' +
                ((new Date() - ts) / 1000) + 's )';
            return step_res;
        })
        .fail(function(res) {
            self._error = true;
            if (current_step.blocking) {
                fs.appendFileSync(REPORT_PATH, step_res + ' ' + res + '\n');
                throw new Error('Blocking libtest failed');
            } else {
                step_res = '        ' + step_res + ' - Failed with \n' +
                    '------------------------------\n' +
                    res +
                    '------------------------------   ' +
                    '( took ' + ((new Date() - ts) / 1000) + 's )';
            }
            console.warn('Failed lib test with', res);
            return step_res;
        });
};


TestRunner.prototype._write_coverage = function() {
    var self = this;
    var collector = new istanbul.Collector();
    var reporter = new istanbul.Reporter(null, COVERAGE_DIR + '/istanbul');
    //Get all collectors data
    return this._bg_client.redirector.publish_to_cluster({
            method_api: 'debug_api',
            method_name: 'get_istanbul_collector',
            target: ''
        }, {
            auth_token: self._client.options.auth_token,
        })
        .then(function(res) {
            //Add all recieved data to the collector
            _.each(res.redirect_reply.aggregated, function(r) {
                if (r.data) {
                    var to_add = r.data;
                    collector.add(JSON.parse(to_add));
                } else {
                    console.warn('r.data is undefined, skipping');
                }
            });

            //Add unit test coverage data if exists (on failure of unit test, does not exist)
            if (fs.existsSync(COVERAGE_DIR + '/mocha/coverage-final.json')) {
                console.warn('No unit test coverage info, skipping');
                collector.add(JSON.parse(fs.readFileSync(COVERAGE_DIR + '/mocha/coverage-final.json', 'utf8')));
            }

            //Generate the report
            reporter.add('lcov');
            return P.fcall(function() {
                    return reporter.write(collector, true /*sync*/ , function() {
                        console.warn('done reporter.write');
                    });
                })
                .fail(function(err) {
                    console.warn('Error on write with', err, err.stack);
                    throw err;
                });
        })
        .fail(function(err) {
            console.warn('Error on _write_coverage', err, err.stack);
            throw err;
        });
};

TestRunner.prototype._restart_services = function(testrun) {
    console.log('Restarting services with TESTRUN arg to', testrun);
    var command;
    if (testrun) { //Add --TESTRUN to the required services
        command = "sed -i 's/\\(.*web_server.js\\)/\\1 --TESTRUN/' /etc/noobaa_supervisor.conf ";
        command += " ; sed -i 's/\\(.*bg_workers_starter.js\\)/\\1 --TESTRUN/' /etc/noobaa_supervisor.conf ";
    } else { //Remove --TESTRUN from the required services
        command = "sed -i 's/\\(.*web_server.js\\).*--TESTRUN/\\1/' /etc/noobaa_supervisor.conf ";
        command += " ; sed -i 's/\\(.*bg_workers_starter.js\\).*--TESTRUN/\\1/' /etc/noobaa_supervisor.conf ";
    }

    return promise_utils.promised_exec(command)
        .then(function() {
            return promise_utils.promised_exec('supervisorctl reload');
        })
        .delay(1000)
        .then(function() {
            return promise_utils.promised_exec('supervisorctl restart webserver bg_workers');
        })
        .delay(5000);

};

module.exports = TestRunner;

function main() {
    if (!argv.GIT_VERSION) {
        console.error('Must supply git version (--GIT_VERSION)');
        process.exit(1);
    }
    var run = new TestRunner(argv);
    return P.when(run.init_run())
        .fail(function(error) {
            console.error('Init run failed, stopping tests', error);
            process.exit(2);
        })
        .then(function() {
            console.warn('Running tests');
            return run.run_tests();
        })
        .fail(function(error) {
            console.error('run tests failed', error);
            process.exit(3);
        })
        .then(function() {
            console.warn('Finalizing run results');
            return run.complete_run();
        })
        .fail(function(error) {
            console.error('Complete run failed', error);
            process.exit(4);
        })
        .then(function() {
            run.print_conclusion();
            if (!run._error) {
                process.exit(0);
            } else {
                process.exit(1);
            }
        });
}

if (require.main === module) {
    main();
}
