(function(window, angular, undefined) {

	var commangular = window.commangular || (window.commangular = {});
		
	commangular.create = function(commandName, commandFunction, commandConfig) {
		
		var commands = commangular.commands || (commangular.commands = {});
		commands[commandName] = {
			function: commandFunction,
			config: commandConfig,
			interceptors:{}
		};
	}

	commangular.aspect = function(aspectDescriptor,aspectFunction) {
		
		var aspects = commangular.aspects || (commangular.aspects = []);
		var result = /@([^(]*)\((.*)\)/.exec(aspectDescriptor);
		//console.log('result:' + result);
		var poincut = result[1];
		var matcher = result[2];
		console.log(poincut)
		if(!/(\bBefore\b|\bAfter\b|\bAfterThrowing\b|\bAround\b)/.test(poincut))
			throw new Error('aspect descriptor ' + aspectDescriptor + ' contains errors');
		aspects.push({poincut:poincut,
			matcher:matcher,
			aspectFunction:aspectFunction});
	}

	//----------------------------------------------------------------------------------------------------------------------

	function CommandDescriptor(commandType) {

		this.commandType = commandType;
		this.descriptors = [];
		this.command = null;
		this.commandConfig;
		this.interceptors;
	}

	CommandDescriptor.prototype.asSequence = function() {

		this.commandType = 'S';
		return this;
	};

	CommandDescriptor.prototype.asParallel = function() {

		this.commandType = 'P';
		return this;			
	};

	CommandDescriptor.prototype.asFlow = function() {

		this.commandType = 'F';
		return this;			
	};

	CommandDescriptor.prototype.add =  function(command) {

		if (angular.isString(command)) {

			command = commangular.commands[command];
		}

		if (command instanceof CommandDescriptor) {

			this.descriptors.push(command);
			return this;
		}
		var commandDescriptor = new CommandDescriptor('E');
		commandDescriptor.command = command.function;
		commandDescriptor.commandConfig = command.config;
		commandDescriptor.interceptors = command.interceptors;
		this.descriptors.push(commandDescriptor);
		return this;
	};
	CommandDescriptor.prototype.resultLink = function(key, value) {

		var descriptor = new ResultKeyLinkDescriptor(key, value,this);
		this.descriptors.push(descriptor); 
		return descriptor;
	};
	CommandDescriptor.prototype.serviceLink = function(service,property,value) {

		var descriptor = new ServiceLinkDescriptor(service, property,value,this);
		this.descriptors.push(descriptor); 
		return descriptor;
	};
	//----------------------------------------------------------------------------------------------------------------------
	function LinkDescriptor(parent) {

		this.commandDescriptor;
		this.parent = parent;
	}

	LinkDescriptor.prototype.to = function(command){

		if (angular.isString(command)) {

			command = commangular.commands[command];
		}

		if (command instanceof CommandDescriptor) {

			this.commandDescriptor = command;
			return this.parent;
		}
		var commandDescriptor = new CommandDescriptor('E');
		commandDescriptor.command = command.function;
		commandDescriptor.commandConfig = command.config;
		commandDescriptor.interceptors = command.interceptors;
		this.commandDescriptor = commandDescriptor;
		return this.parent;
	}; 
	
	//----------------------------------------------------------------------------------------------------------------------
	function ResultKeyLinkDescriptor(key, value,parent) {

		LinkDescriptor.apply(this,[parent])
		this.key = key;
		this.value = value;
				
	}
	ResultKeyLinkDescriptor.prototype = new LinkDescriptor();
	ResultKeyLinkDescriptor.prototype.constructor = ResultKeyLinkDescriptor;
	//----------------------------------------------------------------------------------------------------------------------
	function ServiceLinkDescriptor(service,property, value,parent) {

		LinkDescriptor.apply(this,[parent])
		this.service = service;
		this.property = property;
		this.value = value;
	}
	ServiceLinkDescriptor.prototype = new LinkDescriptor();
	ServiceLinkDescriptor.prototype.constructor = ServiceLinkDescriptor;
	//----------------------------------------------------------------------------------------------------------------------
	function CommandBase(context) {

		this.context = context;
		this.deferred = null;

	}
	//----------------------------------------------------------------------------------------------------------------------

	function Command(command, context, config,interceptors) {

		CommandBase.apply(this, [context]);
		this.command = command;
		this.commandConfig = config;
		this.interceptors = interceptors;

		this.execute = function() {

			var self = this;
			var context = this.context;
			var isError = false;
			
			this.deferred = context.$q.defer();
			var command = context.createCommand(this.command);
			context.intercept('Before',interceptors);
			try {
				var result;
				if(interceptors['Around'])
					result = context.intercept('Around',interceptors,command);
				else{
					
					result = context.invoke(command.execute, command);
				}
				var resultPromise = context.processResults(result, this.deferred, config);
			} catch (error) {
				isError = true;
				context.intercept('AfterThrowing',interceptors);
				if (command.hasOwnProperty('onError')) {

					var contextData = context.getContextData();
					contextData.lastError = error;
					context.invoke(command.onError,command);
				}
				this.deferred.reject(error);
			}
			context.intercept('After',interceptors);
			if (command.hasOwnProperty('onComplete') && !isError) {

				if(resultPromise)
					resultPromise.then(function() {

						context.invoke(command.onComplete,command);
					});
				else
					context.invoke(command.onComplete,command);	
			}
			return this.deferred.promise;
		}
	}
	Command.prototype = new CommandBase();
	Command.prototype.constructor = Command;

	//----------------------------------------------------------------------------------------------------------------------
	function CommandGroup(context, descriptors) {

		CommandBase.apply(this, [context]);
		this.descriptors = descriptors;

		this.start = function() {

			this.deferred = this.context.$q.defer();
			this.execute();
			return this.deferred.promise;
		}
	}
	CommandGroup.prototype = new CommandBase();
	CommandGroup.prototype.constructor = CommandGroup;
	//----------------------------------------------------------------------------------------------------------------------

	function CommandSequence(context, descriptors) {

		CommandGroup.apply(this, [context, descriptors]);
		var currentIndex = 0;

		this.execute = function() {
			var self = this;
			var commandDescriptor = this.descriptors[currentIndex];
			var command = this.context.instantiate(commandDescriptor);

			if (command instanceof Command) {
				command.execute().then(
					function() {
						self.nextCommand();
					},
					function(error) {
						self.deferred.reject(error);
					});
		}
			else
				command.start().then(
					function() {
						self.nextCommand();
					},
					function(error) {
						self.deferred.reject(error);
					});
		};
		this.nextCommand = function() {

			if (++currentIndex == this.descriptors.length) {

				this.deferred.resolve();
				return;
			}
			this.execute();
		};
	}
	CommandSequence.prototype = new CommandGroup();
	CommandSequence.prototype.constructor = CommandSequence;
	//----------------------------------------------------------------------------------------------------------------------
	function CommandParallel(context, descriptors) {

		CommandGroup.apply(this, [context, descriptors]);
		var totalComplete = 0;

		this.execute = function() {

			var self = this;
			for (var x = 0; x < this.descriptors.length; x++) {

				var commandDescriptor = this.descriptors[x];
				var command = this.context.instantiate(commandDescriptor);

				if (command instanceof Command)
					command.execute().then(
						function() {
							self.checkComplete();
						},
						function(error) {
							self.deferred.reject(error);
						});
				else
					command.start().then(
						function() {
							self.checkComplete();
						},
						function(error) {
							self.deferred.reject(error);
						});
			}
		};
		this.checkComplete = function() {

			if (++totalComplete == this.descriptors.length)
				this.deferred.resolve();
		};
	}

	CommandParallel.prototype = new CommandGroup();
	CommandParallel.prototype.constructor = CommandParallel;
	//----------------------------------------------------------------------------------------------------------------------
	function CommandFlow(context, descriptors) {

		CommandGroup.apply(this, [context, descriptors]);
		var currentIndex = 0;
		this.execute = function() {

			var self = this;
			var descriptor = this.descriptors[currentIndex];
			if (descriptor instanceof ResultKeyLinkDescriptor) {
				if (this.context.contextData[descriptor.key] === descriptor.value) {
						
					var command = this.context.instantiate(descriptor.commandDescriptor);
					if (command instanceof Command)
						command.execute().then(function() {
							self.next();
						});
					else
						command.start().then(function() {
							self.next();
					});
				} else {
					this.next();
				}
			}
			if (descriptor instanceof ServiceLinkDescriptor) {
								
				var service = this.context.$injector.get(descriptor.service);
				if (service[descriptor.property] === descriptor.value) {
						
					var command = this.context.instantiate(descriptor.commandDescriptor);
					if (command instanceof Command)
						command.execute().then(function() {
							self.next();
						});
					else
						command.start().then(function() {
							self.next();
					});
				} else {
					this.next();
				}
			}
		};
		this.next = function() {

			if (++currentIndex == this.descriptors.length) {

				this.deferred.resolve();
				return;
			}
			this.execute();
		};
	}

	CommandParallel.prototype = new CommandGroup();
	CommandParallel.prototype.constructor = CommandFlow;
	//----------------------------------------------------------------------------------------------------------------------
	function CommandContext($injector, $q,data) {

		this.contextData = data || {};
		this.instantiator = new CommandInstantiator();
		this.$injector = $injector;
		this.$q = $q;
		this.contextData.commandModel = {};
	}

	CommandContext.prototype.instantiate = function(descriptor) {

		var command = this.instantiator.instantiate(descriptor, this);
		return command;
	};

	CommandContext.prototype.processResults = function(result, deferred, config) {

		var self = this;
		if (!result) {

			deferred.resolve();
			return;
		}

		var promise = this.$q.when(result).then(function(data) {

			self.contextData.lastResult = data;
			if (config && config.resultKey) {
				self.contextData[config.resultKey] = data;
			}
			deferred.resolve();
		});
		return promise;
	};

	CommandContext.prototype.invoke = function(theFunction, self) {

		return this.$injector.invoke(theFunction,self,this.contextData);
	};
	CommandContext.prototype.createCommand = function(command) {

		return this.$injector.instantiate(command,this.contextData);
	};
	CommandContext.prototype.getContextData = function(resultKey) {

		return this.contextData;
	};

	CommandContext.prototype.intercept = function(poincut,interceptors,command) {

		var self = this;

		switch(poincut) {

			case 'Around' : {

				var processor = new AroundProcessor(command.execute,null,self);
				angular.forEach(interceptors[poincut],function(value){
				
					processor = new AroundProcessor(value,processor,self);
				});
				return processor.invoke();
				break;
			}
			default : {

				if(interceptors[poincut]) {

					angular.forEach(interceptors[poincut],function(value){
						console.log(value);
						self.invoke(value,value);
					});
				}
				break;
			}
		}
	};
	//----------------------------------------------------------------------------------------------------------------------

	function CommandInstantiator() {};

	CommandInstantiator.prototype.instantiate = function(descriptor,context) {

		switch (descriptor.commandType) {

			case 'S':
				return new CommandSequence(context, descriptor.descriptors);
			case 'P':
				return new CommandParallel(context, descriptor.descriptors);
			case 'E':
				return new Command(descriptor.command, context, descriptor.commandConfig,descriptor.interceptors);
			case 'F':
				return new CommandFlow(context, descriptor.descriptors);
		}
	};
	//----------------------------------------------------------------------------------------------------------------------
	function AroundProcessor(executed,next,context) {

		this.context = context;
		this.executed = executed;
		this.next = next;
	}
	AroundProcessor.prototype.invoke = function() {
	
		this.context.contextData.processor = this.next;
		return this.context.invoke(this.executed,this.executed);
	}
	//----------------------------------------------------------------------------------------------------------------------
	angular.module('commangular', [])
		.provider('$commangular', function() {

			var descriptors = {};
						
			return {
				$get: ['commandExecutor',
					function(commandExecutor) {

						commandExecutor.descriptors = descriptors;
						return {
							dispatch: function(eventName, data) {

								return commandExecutor.execute(eventName, data);
							}
						}
					}
				],
		
				mapTo: function(eventName) {

					var descriptor = new CommandDescriptor();
					descriptors[eventName] = descriptor;
					return descriptor
				},

				asSequence : function() {

					return new CommandDescriptor('S');
				},
				asParallel : function() {

					return new CommandDescriptor('P');
				},
				asFlow : function() {

					return new CommandDescriptor('F');
				},
				
				findCommand: function(eventName) {

					return descriptors[eventName];
				}

			};

		});

	//-----------------------------------------------------------------------------------------------------------------

	angular.module('commangular')
		.service('commandExecutor', ['$injector', '$q',
			function($injector, $q) {

				return {

					descriptors: {},

					execute: function(eventName, data) {
						var deferred = $q.defer();
						var context = new CommandContext($injector, $q,data);
						var commandDescriptor = this.descriptors[eventName];
						var command = context.instantiate(commandDescriptor);
						command.start().then(function(data) {
							
							deferred.resolve();
						}, function(error) {

							console.log("Command context end with error :" + error);
							deferred.reject(error);
						});
						return deferred.promise;
					},

				};
			}
		]);
	//------------------------------------------------------------------------------------------------------------------
	angular.module('commangular')
		.run(function() {

			for (var i = 0; i < commangular.aspects.length; i++) {
				
				var aspect = commangular.aspects[i];
				if(/\/(.*)\//.test(aspect.matcher)) {

					for(var key in commangular.commands) {
						var regex = new RegExp(/\/(.*)\//.exec(aspect.matcher)[1]);
						if(regex.test(key)){
							if(!commangular.commands[key].interceptors[aspect.poincut])
								commangular.commands[key].interceptors[aspect.poincut] = [];
							commangular.commands[key].interceptors[aspect.poincut].push(aspect.aspectFunction);
						}
					}	
				}
			}
		}); 
	//------------------------------------------------------------------------------------------------------------------ 
})(window, angular);