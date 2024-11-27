// eslint-disable-next-line import/no-unresolved
import cron from 'node-cron';
// eslint-disable-next-line import/no-unresolved
import graphite from 'graphite';
import { createLogger, format, transports } from 'winston';
// eslint-disable-next-line import/no-unresolved
import 'winston-daily-rotate-file';
// eslint-disable-next-line import/no-unresolved
import express from 'express';
import ApiFunc from './apiFunctions.js';
import loadUsers from './users.js';

const app = express();
const pushStatusPort = Number(process.env.PUSH_STATUS_PORT);
let lastUpload = new Date().getTime();

const pushTransport = new transports.DailyRotateFile({
  filename: 'logs/push-%DATE%.log',
  auditFile: 'logs/push-audit.json',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});
const cronTransport = new transports.DailyRotateFile({
  filename: 'logs/cron-%DATE%.log',
  auditFile: 'logs/cron-audit.json',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
});

const client = graphite.createClient('plaintext://graphite:2003/');
const { combine, timestamp, prettyPrint } = format;
const logger = createLogger({
  format: combine(timestamp(), prettyPrint()),
  transports: [pushTransport],
});

const cronLogger = createLogger({
  format: combine(timestamp(), prettyPrint()),
  transports: [cronTransport],
});

/**
 * Extracts the error message from an error object
 * @param {string} message
 * @param {unknown} error
 */
const getErrorMessage = (message, error) => {
  if (error instanceof Error) {
    console.error(message, error.message);
  } else {
    console.error(message, 'Unknown error\n', error);
  }
};

class ManageStats {
  /** @type {Record<string, {[shard: string]: UserInfo}>} */
  groupedStats;

  /** @type {Record<string, number>} */
  static lastMemoryCall = {};

  constructor() {
    this.groupedStats = {};
  }

  /**
   * Handles the users for a specific host
   * @param {string} host
   * @param {UserInfo[]} hostUsers
   * @returns
   */
  async handleUsers(host, hostUsers) {
    console.log(`[${host}] Handling Users`);
    const now = new Date();

    /** @type {(Promise<void>)[]} */
    const getStatsFunctions = [];
    for (const user of hostUsers) {
      try {
        if (user.host !== host) continue;

        let shard;
        if (user.segment === undefined) {
          shard = user.shards[now.getMinutes() % user.shards.length];
        } else {
          shard = user.shards[now.getSeconds() % user.shards.length];
        }

        const username = user.replaceName ? user.replaceName : user.username;
        const userStatsKey = (user.prefix ? `${user.prefix}.` : '') + username;
        const userShardKey = `${host}_${user.type}_${userStatsKey}_${shard}`;

        const lastCall = ManageStats.lastMemoryCall[userShardKey] || 0;
        const timeSinceLastCall = (now.getTime() - lastCall) / 1000;

        if (user.segment === undefined) {
          if (timeSinceLastCall >= 60) {
            getStatsFunctions.push(this.getStats(user, shard));
            ManageStats.lastMemoryCall[userShardKey] = now.getTime();
          }
        } else if (timeSinceLastCall >= 10) {
          getStatsFunctions.push(this.getStats(user, shard));
          ManageStats.lastMemoryCall[userShardKey] = now.getTime();
        }
      } catch (error) {
        logger.error(error);
      }
    }

    console.log(`[${host}] Getting ${getStatsFunctions.length} statistics`);

    await Promise.all(getStatsFunctions);

    /** @type {Record<string, any>} */
    const stats = {
      stats: this.groupedStats,
    };

    if (!host.startsWith('screeps.com')) {
      const serverStats = await ApiFunc.getServerStats(host, hostUsers[0].port);
      const adminUtilsServerStats = await ApiFunc.getAdminUtilsServerStats(host, hostUsers[0].port);
      if (adminUtilsServerStats) {
        try {
          /** @type {Record<string, any>} */
          const groupedAdminStatsUsers = {};
          for (const [username, user] of Object.entries(adminUtilsServerStats)) {
            groupedAdminStatsUsers[username] = user;
          }

          adminUtilsServerStats.users = groupedAdminStatsUsers;
        } catch (error) {
          console.log(error);
        }
      }
      console.log(
        `[${host}] Server stats: ${serverStats ? 'yes' : 'no'}, adminUtils: ${adminUtilsServerStats ? 'yes' : 'no'}`,
      );
      stats.serverStats = serverStats;
      stats.adminUtilsServerStats = adminUtilsServerStats;
    }

    const push = await ManageStats.reportStats(stats);
    if (!push) {
      console.log(`[${host}] Error while pushing stats`);
      return;
    }
    /** @type {string[]} */
    const typesPushed = [];
    if (Object.keys(stats.stats).length > 0) {
      typesPushed.push(host);
    }
    if (stats.serverStats) {
      typesPushed.push('server stats');
    }
    if (stats.adminUtilsServerStats) {
      typesPushed.push('admin-utils stats');
    }
    if (typesPushed.length) {
      logger.info(`> [${host}] Pushed ${typesPushed.join(', ')}`);
    } else {
      logger.info(`> [${host}] Pushed no stats`);
    }
  }

  /**
   * Adds leaderboard data to the stats
   * @param {UserInfo} userinfo
   * @returns {Promise<{ rank: number, score: number }>}
   */
  static async addLeaderboardData(userinfo) {
    try {
      const leaderboard = await ApiFunc.getLeaderboard(userinfo);
      if (!leaderboard) return { rank: 0, score: 0 };
      const leaderboardList = leaderboard.list;
      if (leaderboardList.length === 0) return { rank: 0, score: 0 };
      const { rank, score } = leaderboardList.slice(-1)[0];
      return { rank, score };
    } catch (error) {
      return { rank: 0, score: 0 };
    }
  }

  /**
   *
   * @param {UserInfo} userinfo
   * @returns
   */
  static async getLoginInfo(userinfo) {
    if (userinfo.type === 'private') {
      userinfo.token = await ApiFunc.getPrivateServerToken(userinfo);
    }
    return userinfo.token;
  }

  /**
   * Gets the stats for a user
   * @param {UserInfo} userinfo
   * @param {string} shard
   * @returns {Promise<void>}
   */
  async getStats(userinfo, shard) {
    await ManageStats.getLoginInfo(userinfo);
    const stats =
      userinfo.segment === undefined
        ? await ApiFunc.getMemory(userinfo, shard)
        : await ApiFunc.getSegmentMemory(userinfo, shard);

    if (!stats) {
      logger.error(`Failed to grab memory from ${userinfo.username} in ${shard}`);
      return;
    }
    if (Object.keys(stats).length === 0) return;

    console.log(`Got memory from ${userinfo.username} in ${shard}`);

    const me = await ApiFunc.getUserinfo(userinfo);
    if (me) stats.power = me.power || 0;
    stats.leaderboard = await ManageStats.addLeaderboardData(userinfo);
    this.pushStats(userinfo, stats, shard);
  }

  /**
   * Reports the stats to the graphite server
   * @param {*} stats
   * @returns
   */
  static async reportStats(stats) {
    return new Promise((resolve) => {
      if (Object.keys(stats).length === 0) {
        resolve(false);
      }
      console.debug(`Writing stats ${JSON.stringify(stats)}`);
      client.write(
        {
          [`${process.env.PREFIX ? `${process.env.PREFIX}.` : ''}screeps`]: stats,
        },
        (err) => {
          if (err) {
            console.error(err);
            logger.error(err);
            resolve(false);
          }
          lastUpload = new Date().getTime();
          resolve(true);
        },
      );
    });
  }

  /**
   * Pushes the stats to the grouped stats
   * @param {UserInfo} userinfo
   * @param {*} stats
   * @param {string} shard
   * @returns
   */
  pushStats(userinfo, stats, shard) {
    const statSize = Object.keys(stats).length;
    if (statSize === 0) return;
    const username = userinfo.replaceName ? userinfo.replaceName : userinfo.username;
    const userStatsKey = (userinfo.prefix ? `${userinfo.prefix}.` : '') + username;

    console.log(`[${userinfo.host}] Pushing ${statSize} stats for ${userStatsKey} in ${shard}`);
    if (!this.groupedStats[userStatsKey]) {
      this.groupedStats[userStatsKey] = { [shard]: stats };
    } else {
      this.groupedStats[userStatsKey][shard] = stats;
    }
  }
}

/**
 *
 * @param {Record<string, UserInfo[]>} usersByHost
 */
const handleAllUsers = async (usersByHost) => {
  const promises = [];

  for (const [host, usersForHost] of Object.entries(usersByHost)) {
    promises.push(
      new ManageStats().handleUsers(host, usersForHost).catch((error) => {
        cronLogger.error(getErrorMessage(`Error handling users for host ${host}:`, error));
      }),
    );
  }

  await Promise.all(promises);
};

cron.schedule('*/10 * * * * *', async () => {
  console.log(`Cron event hit: ${new Date()}`);
  cronLogger.info(`Cron event hit: ${new Date()}`);

  try {
    /** @type {UserInfo[]} */
    const users = await loadUsers();

    if (!users || users.length === 0) {
      cronLogger.warn('No users data found');
      return;
    }

    const usersByHost = users.reduce((group, user) => {
      const { host } = user;
      group[host] = group[host] ?? [];
      group[host].push(user);
      return group;
    }, /** @type {Record<string, UserInfo[]>} */ ({}));

    await handleAllUsers(usersByHost);
  } catch (error) {
    cronLogger.error(getErrorMessage('Error in cron job:', error));
  }
});

if (pushStatusPort) {
  app.listen(pushStatusPort, () => {
    console.log(`App listening at http://localhost:${pushStatusPort}`);
  });

  app.get('/', (req, res) => {
    const diffCompleteMinutes = Math.ceil(Math.abs(new Date().getTime() - lastUpload) / (1000 * 60));
    res.json({
      result: diffCompleteMinutes < 300,
      lastUpload,
      diffCompleteMinutes,
    });
  });
}
