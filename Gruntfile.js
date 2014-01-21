process.env.REDIS_VERSION = process.env.REDIS_VERSION || '2.8.4'

module.exports = function(grunt) {
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    shell: {                                // Task
      listFolders: {                      // Target
        options: {                      // Options
          stdout: true
        },
          command: 'ls'
        },
        getRedis: {
          options: {
            stdout: true
          },
          command: 'mkdir -p tmp && cd tmp && \
                    wget -N http://download.redis.io/releases/redis-' + process.env.REDIS_VERSION + '.tar.gz && \
                    tar xzf redis-' + process.env.REDIS_VERSION + '.tar.gz && \
                    cd redis-' + process.env.REDIS_VERSION + ' && \
                    make'
        }
    }

  });

  grunt.loadNpmTasks('grunt-shell');
  grunt.registerTask('getRedis', ['shell:getRedis']);
  
};
