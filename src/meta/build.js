'use strict';

const os = require('os');
const async = require('async');
const winston = require('winston');
const nconf = require('nconf');
const _ = require('lodash');
const db = require('../database');

const cacheBuster = require('./cacheBuster');
let meta;

function step(target, callback) {
	var startTime = Date.now();
	winston.info('[build] ' + target + ' build started');

	return function (err) {
		if (err) {
			winston.error('[build] ' + target + ' build failed');
			return callback(err);
		}

		var time = (Date.now() - startTime) / 1000;

		winston.info('[build] ' + target + ' build completed in ' + time + 'sec');
		callback();
	};
}

var targetHandlers = {
	'plugin static dirs': function (parallel, callback) {
		meta.js.linkStatics(callback);
	},
	'requirejs modules': function (parallel, callback) {
		meta.js.buildModules(parallel, callback);
	},
	'client js bundle': function (parallel, callback) {
		meta.js.buildBundle('client', parallel, callback);
	},
	'admin js bundle': function (parallel, callback) {
		meta.js.buildBundle('admin', parallel, callback);
	},
	javascript: [
		'plugin static dirs',
		'requirejs modules',
		'client js bundle',
		'admin js bundle',
	],
	'client side styles': function (parallel, callback) {
		return callback();
		// meta.css.buildBundle('client', parallel, callback);
	},
	'admin control panel styles': function (parallel, callback) {
		return callback();
		// meta.css.buildBundle('admin', parallel, callback);
	},
	styles: [
		'client side styles',
		'admin control panel styles',
	],
	templates: function (parallel, callback) {
		meta.templates.compile(callback);
	},
	languages: function (parallel, callback) {
		meta.languages.build(callback);
	},
	sounds: function (parallel, callback) {
		meta.sounds.build(callback);
	},
};

var aliases = {
	'plugin static dirs': ['staticdirs'],
	'requirejs modules': ['rjs', 'modules'],
	'client js bundle': ['clientjs', 'clientscript', 'clientscripts'],
	'admin js bundle': ['adminjs', 'adminscript', 'adminscripts'],
	javascript: ['js'],
	'client side styles': [
		'clientcss', 'clientless', 'clientstyles', 'clientstyle',
	],
	'admin control panel styles': [
		'admincss', 'adminless', 'adminstyles', 'adminstyle', 'acpcss', 'acpless', 'acpstyles', 'acpstyle',
	],
	styles: ['css', 'less', 'style'],
	templates: ['tpl'],
	languages: ['lang', 'i18n'],
	sounds: ['sound'],
};

exports.aliases = aliases;

aliases = Object.keys(aliases).reduce(function (prev, key) {
	var arr = aliases[key];
	arr.forEach(function (alias) {
		prev[alias] = key;
	});
	prev[key] = key;
	return prev;
}, {});

function beforeBuild(targets, callback) {

	require('colors');
	process.stdout.write('  started'.green + '\n'.reset);

	async.series([
		function (next) {
			db.init(next);
		},
		function (next) {
			meta = require('../meta');
			meta.themes.setupPaths(next);
		},
		function (next)	{
			var plugins = require('../plugins');
			plugins.prepareForBuild(targets, next);
		},
	], function (err) {
		if (err) {
			winston.error('[build] Encountered error preparing for build', err);
			return callback(err);
		}

		callback();
	});
}

var allTargets = Object.keys(targetHandlers).filter(function (name) {
	return typeof targetHandlers[name] === 'function';
});
function buildTargets(targets, parallel, callback) {
	var all = parallel ? async.each : async.eachSeries;

	var length = Math.max.apply(Math, targets.map(function (name) {
		return name.length;
	}));

	all(targets, function (target, next) {
		targetHandlers[target](parallel, step(_.padStart(target, length) + ' ', next));
	}, err => callback(err));
}

exports.build = function (targets, options, callback) {
	if (!callback && typeof options === 'function') {
		callback = options;
		options = {};
	} else if (!options) {
		options = {};
	}

	if (targets === true) {
		targets = allTargets;
	} else if (!Array.isArray(targets)) {
		targets = targets.split(',');
	}

	let series = nconf.get('series') || options.series;
	if (series === undefined) {
		// Detect # of CPUs and select strategy as appropriate
		winston.verbose('[build] Querying CPU core count for build strategy');
		const cpus = os.cpus();
		series = cpus.length < 4;
		winston.verbose('[build] System returned ' + cpus.length + ' cores, opting for ' + (series ? 'series' : 'parallel') + ' build strategy');
	}

	targets = targets
		// get full target name
		.map(function (target) {
			target = target.toLowerCase().replace(/-/g, '');
			if (!aliases[target]) {
				winston.warn('[build] Unknown target: ' + target);
				if (target.includes(',')) {
					winston.warn('[build] Are you specifying multiple targets? Separate them with spaces:');
					winston.warn('[build]   e.g. `./nodebb build adminjs tpl`');
				}

				return false;
			}

			return aliases[target];
		})
		// filter nonexistent targets
		.filter(Boolean);

	// map multitargets to their sets
	targets = _.uniq(_.flatMap(targets, target => (
		Array.isArray(targetHandlers[target]) ?
			targetHandlers[target] :
			target
	)));

	winston.verbose('[build] building the following targets: ' + targets.join(', '));

	if (!targets) {
		winston.info('[build] No valid targets supplied. Aborting.');
		callback();
	}

	var startTime;
	var totalTime;
	async.series([
		async.apply(beforeBuild, targets),
		function (next) {
			var threads = parseInt(nconf.get('threads'), 10);
			if (threads) {
				require('./minifier').maxThreads = threads - 1;
			}

			if (!series) {
				winston.info('[build] Building in parallel mode');
			} else {
				winston.info('[build] Building in series mode');
			}

			startTime = Date.now();
			buildTargets(targets, !series, next);
		},
		async function () {
			await bundle();
		},
		function (next) {
			totalTime = (Date.now() - startTime) / 1000;
			cacheBuster.write(next);
		},
	], function (err) {
		if (err) {
			winston.error('[build] Encountered error during build step', err);
			return callback(err);
		}

		winston.info('[build] Asset compilation successful. Completed in ' + totalTime + 'sec.');
		callback();
	});
};


function getWebpackConfig() {
	return require(global.env !== 'development' ? '../../webpack.prod' : '../../webpack.dev');
}

async function bundle() {
	winston.info('[build] Bundling with Webpack.');
	const webpack = require('webpack');
	const webpackCfg = getWebpackConfig();
	const pluginPaths = await db.getSortedSetRange('plugins:active', 0, -1);
	if (!pluginPaths.includes('nodebb-plugin-composer-default')) {
		pluginPaths.push('nodebb-plugin-composer-default');
	}

	pluginPaths.map(p => 'node_modules/' + p + '/node_modules');
	webpackCfg.resolve.modules = webpackCfg.resolve.modules.concat(pluginPaths);
	const util = require('util');
	const webpackAsync = util.promisify(webpack);
	try {
		const stats = await webpackAsync(webpackCfg);

		if (stats.hasErrors() || stats.hasWarnings()) {
			const info = stats.toString('minimal');
			console.log(info);
		}
	} catch (err) {
		console.error(err.stack || err);
		if (err.details) {
			console.error(err.details);
		}
	}
}

exports.buildAll = function (callback) {
	exports.build(allTargets, callback);
};

require('../promisify')(exports);
