/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in this folder for license information.
 *--------------------------------------------------------*/

import * as semver from 'semver';

export interface Tool {
	name: string;
	importPath: string;
	modulePath: string;
	isImportant: boolean;
	replacedByGopls?: boolean;
	description: string;

	// If true, consider prerelease version in preview mode
	// (nightly & dev)
	usePrereleaseInPreviewMode?: boolean;
	// If set, this string will be used when installing the tool
	// instead of the default 'latest'. It can be used when
	// we need to pin a tool version (`deadbeaf`) or to use
	// a dev version available in a branch (e.g. `master`).
	defaultVersion?: string;

	// latestVersion and latestVersionTimestamp are hardcoded default values
	// for the last known version of the given tool. We also hardcode values
	// for the latest known pre-release of the tool for the Nightly extension.
	latestVersion?: semver.SemVer;
	latestVersionTimestamp?: moment.Moment;
	latestPrereleaseVersion?: semver.SemVer;
	latestPrereleaseVersionTimestamp?: moment.Moment;

	// minimumGoVersion and maximumGoVersion set the range for the versions of
	// Go with which this tool can be used.
	minimumGoVersion?: semver.SemVer;
	maximumGoVersion?: semver.SemVer;

	// close performs any shutdown tasks that a tool must execute before a new
	// version is installed. It returns a string containing an error message on
	// failure.
	close?: (env: NodeJS.Dict<string>) => Promise<string>;
}

/**
 * ToolAtVersion is a Tool at a specific version.
 * Lack of version implies the latest version.
 */
export interface ToolAtVersion extends Tool {
	version?: semver.SemVer;
}