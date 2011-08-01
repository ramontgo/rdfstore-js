// exports
exports.Callbacks = {};
var Callbacks = exports.Callbacks;

//imports
var Utils = require("./../../js-trees/src/utils").Utils;
var QuadBackend = require("./../../js-rdf-persistence/src/quad_backend").QuadBackend;
var QuadIndexCommon = require("./../../js-rdf-persistence/src/quad_index_common").QuadIndexCommon;
var RDFJSInterface = require("./rdf_js_interface").RDFJSInterface;
var AbstractQueryTree = require("./../../js-sparql-parser/src/abstract_query_tree").AbstractQueryTree;


Callbacks.ANYTHING = {'token': 'var', 
                      'value': '_'};

Callbacks.added = 'added';
Callbacks.deleted = 'deleted';

Callbacks.CallbacksBackend = function() {
    this.aqt = new AbstractQueryTree.AbstractQueryTree();
    this.engine = arguments[0];
    this.indexMap = {};
    this.observersMap = {};
    this.queriesIndexMap = {};
    this.queriesList = [];
    this.pendingQueries = [];
    this.matchedQueries = [];
    this.updateInProgress = null;
    this.indices = ['SPOG', 'GP', 'OGS', 'POG', 'GSP', 'OS'];
    this.componentOrders = {
        SPOG: ['subject', 'predicate', 'object', 'graph'],
        GP: ['graph', 'predicate', 'subject', 'object'],
        OGS: ['object', 'graph', 'subject', 'predicate'],
        POG: ['predicate', 'object', 'graph', 'subject'],
        GSP: ['graph', 'subject', 'predicate', 'object'],
        OS: ['object', 'subject', 'predicate', 'graph']
    };

    this.callbackCounter = 0;
    this.callbacksMap = {};
    this.callbacksInverseMap = {};

    this.queryCounter = 0;
    this.queriesMap = {};
    this.queriesCallbacksMap = {};
    this.queriesInverseMap = {};

    for(var i=0; i<this.indices.length; i++) {
        var indexKey = this.indices[i];
        this.indexMap[indexKey] = {};
        this.queriesIndexMap[indexKey] = {};
    };
};

Callbacks.CallbacksBackend.prototype.startGraphModification = function() {
    this.pendingQueries = [].concat(this.queriesList);
    this.matchedQueries = [];

    var added = Callbacks['added'];
    var deleted = Callbacks['deleted'];
    if(this.updateInProgress == null) {
        this.updateInProgress = {added: [], deleted: []};
    }
};

Callbacks.CallbacksBackend.prototype.nextGraphModification = function(event, quad) {
    this.updateInProgress[event].push(quad);
};

Callbacks.CallbacksBackend.prototype.endGraphModification = function(callback) {
    var that = this;
    if(this.updateInProgress != null) {
        var tmp = that.updateInProgress;
        that.updateInProgress = null;
        this.sendNotification(Callbacks['deleted'], tmp[Callbacks['deleted']],function(){
            that.sendNotification(Callbacks['added'], tmp[Callbacks['added']], function(){
                that.dispatchQueries(function(){
                    callback(true);
                });
            });
        });
    } else {
        callback(true);
    }
};

Callbacks.CallbacksBackend.prototype.cancelGraphModification = function() {
    this.updateInProgress = null;
};

Callbacks.CallbacksBackend.prototype.sendNotification = function(event, quadsPairs, doneCallback) {
    var notificationsMap = {};
    for(var i=0; i<quadsPairs.length; i++) {
        var quadPair = quadsPairs[i];
        for(var indexKey in this.indexMap) {
            var index = this.indexMap[indexKey];
            var order = this.componentOrders[indexKey];
            this._searchCallbacksInIndex(index, order, event, quadPair, notificationsMap);
            if(this.pendingQueries.length != 0) {
                index = this.queriesIndexMap[indexKey];
                this._searchQueriesInIndex(index, order, quadPair);
            }
        }
    }

    this.dispatchNotifications(notificationsMap);

    if(doneCallback != null)
        doneCallback(true);
};

Callbacks.CallbacksBackend.prototype.dispatchNotifications = function(notificationsMap) {
    for(var callbackId in notificationsMap) {
        var callback = this.callbacksMap[callbackId];
        var deleted = notificationsMap[callbackId][Callbacks['deleted']];
        if(deleted!=null) {
            callback(Callbacks['deleted'],deleted);
        }
        for(var event in notificationsMap[callbackId]) {
            if(event!=Callbacks['deleted']) {
                callback(event, notificationsMap[callbackId][event]);
            }
        }
    }
};

Callbacks.CallbacksBackend.prototype._searchCallbacksInIndex = function(index, order, event, quadPair, notificationsMap) {
    var quadPairNomalized = quadPair[1];
    var quadPair = quadPair[0];

    for(var i=0; i<(order.length+1); i++) {
        var matched = index['_'] || [];
        
        var filteredIds = [];
        for(var j=0; j<matched.length; j++) {
            var callbackId = matched[j];
            if(this.callbacksMap[callbackId] != null) {
                notificationsMap[callbackId] = notificationsMap[callbackId] || {};
                notificationsMap[callbackId][event] = notificationsMap[callbackId][event] || [];
                notificationsMap[callbackId][event].push(quadPair);
                filteredIds.push(callbackId);
            }
        }
        index['_'] = filteredIds;
        var component = order[i];
        if(index[''+quadPairNomalized[component]] != null) {
            index = index[''+quadPairNomalized[component]];
        } else {
            break;
        }
    }
};

Callbacks.CallbacksBackend.prototype.subscribe = function(s,p,o,g,callback, doneCallback) {
    var quad = this._tokenizeComponents(s,p,o,g);
    var queryEnv = {blanks:{}, outCache:{}};
    var that = this;
    this.engine.normalizeQuad(quad, queryEnv, true, function(success, normalized){
        if(success == true) {
            var pattern =  new QuadIndexCommon.Pattern(normalized);        
            var indexKey = that._indexForPattern(pattern);
            var indexOrder = that.componentOrders[indexKey];
            var index = that.indexMap[indexKey];
            for(var i=0; i<indexOrder.length; i++) {
                var component = indexOrder[i];
                var quadValue = normalized[component];
                if(quadValue === '_') {
                    if(index['_'] == null) {
                        index['_'] = [];
                    }
                    that.callbackCounter++;
                    index['_'].push(that.callbackCounter);
                    that.callbacksMap[that.callbackCounter] = callback;
                    that.callbacksInverseMap[callback] = that.callbackCounter;
                    break;
                } else {
                    if(i===indexOrder.length-1) {
                        index[quadValue] = index[quadValue] || {'_':[]};
                        that.callbackCounter++;
                        index[quadValue]['_'].push(that.callbackCounter);
                        that.callbacksMap[that.callbackCounter] = callback;
                        that.callbacksInverseMap[callback] = that.callbackCounter;
                    } else {
                        index[quadValue] = index[quadValue] || {};
                        index = index[quadValue];
                    }
                }
            }
            if(doneCallback != null)
                doneCallback(true);

        } else {
            doneCallback(false);
        }
    });
};

Callbacks.CallbacksBackend.prototype.unsubscribe = function(callback) {
    var id = this.callbacksInverseMap[callback];
    if(id != null) {
        delete this.callbacksInverseMap[callback];
        delete this.callbacksMap[id];
    }
};

Callbacks.CallbacksBackend.prototype._tokenizeComponents = function(s, p, o, g) {
    var pattern = {};

    if(s == null) {
        pattern['subject'] = Callbacks.ANYTHING;
    } else {
        pattern['subject'] = {'token': 'uri', 'value':s};
    }

    if(p == null) {
        pattern['predicate'] = Callbacks.ANYTHING;
    } else {
        pattern['predicate'] = {'token': 'uri', 'value':p};
    }

    if(o == null) {
        pattern['object'] = Callbacks.ANYTHING;
    } else {
        pattern['object'] = {'token': 'uri', 'value':o};
    }

    if(g == null) {
        pattern['graph'] = Callbacks.ANYTHING;
    } else {
        pattern['graph'] = {'token': 'uri', 'value':g};
    }

    return pattern;
};

Callbacks.CallbacksBackend.prototype._indexForPattern = function(pattern) {
    var indexKey = pattern.indexKey;
    var matchingIndices = this.indices;

    for(var i=0; i<matchingIndices.length; i++) {
        var index = matchingIndices[i];
        var indexComponents = this.componentOrders[index];
        for(var j=0; j<indexComponents.length; j++) {
            if(Utils.include(indexKey, indexComponents[j])===false) {
                break;
            }
            if(j==indexKey.length-1) {
                return index;
            }
        }
    }
    
    return 'SPOG' // If no other match, we return the most generic index
};

Callbacks.CallbacksBackend.prototype.observeNode = function() {
    var uri,graphUri,callback,doneCallback;

    if(arguments.length === 4) {
        uri = arguments[0];
        graphUri = arguments[1];
        callback = arguments[2];
        doneCallback = arguments[3];
    } else {
        uri = arguments[0];
        graphUri = this.engine.lexicon.defaultGraphUri;
        callback = arguments[1];
        doneCallback = arguments[2];
    }
    var query = "CONSTRUCT { <" + uri + "> ?p ?o } WHERE { GRAPH <" + graphUri + "> { <" + uri + "> ?p ?o } }";
    var that = this;
    var queryEnv = {blanks:{}, outCache:{}};
    var bindings = [];
    this.engine.execute(query,  function(success, graph){
        if(success) {
            var node = graph;
            var observer = function(event, triples){
                for(var i = 0; i<triples.length; i++) {
                    var triple = triples[i];
                    var s = RDFJSInterface.buildRDFResource(triple.subject,bindings,that.engine,queryEnv);
                    var p = RDFJSInterface.buildRDFResource(triple.predicate,bindings,that.engine,queryEnv);
                    var o = RDFJSInterface.buildRDFResource(triple.object,bindings,that.engine,queryEnv);
                    if(s!=null && p!=null && o!=null) {
                        triple = new RDFJSInterface.Triple(s,p,o);
                        if(event === Callbacks['added']) {
                            node.add(triple);
                        } else if(event === Callbacks['deleted']) {
                            node.remove(triple);
                        }
                    }
                }

                callback(node);
            };
            that.observersMap[callback] = observer;
            that.subscribe(uri,null,null,null,observer,doneCallback);
            callback(node);
        } else {
            doneCallback(false);
        }
    });
};

Callbacks.CallbacksBackend.prototype.stopObservingNode = function(callback) {
    var observer = this.observersMap[callback];
    if(observer) {
        this.unsubscribe(observer);
        return true;
    } else {
        return false;
    }
};

// Queries

Callbacks.CallbacksBackend.prototype.observeQuery = function(query, callback, endCallback) {
    var queryParsed = this.aqt.parseQueryString(query);
    var parsedTree = this.aqt.parseSelect(queryParsed.units[0]);
    var patterns = this.aqt.collectBasicTriples(parsedTree);
    var that = this;
    var queryEnv = {blanks:{}, outCache:{}};
    var floop, pattern, quad, indexKey, indexOrder, index;

    var counter = this.queryCounter;
    this.queryCounter++;
    this.queriesMap[counter] = query;
    this.queriesInverseMap[query] = counter;
    this.queriesList.push(counter);
    this.queriesCallbacksMap[counter] = callback;

    Utils.repeat(0, patterns.length,
                 function(k,env) {
                     floop = arguments.callee;
                     quad = patterns[env._i];
                     if(quad.graph == null) {
                         quad.graph = that.engine.lexicon.defaultGraphUriTerm;
                     }

                     that.engine.normalizeQuad(quad, queryEnv, true, function(success, normalized){
                         pattern =  new QuadIndexCommon.Pattern(normalized);        
                         indexKey = that._indexForPattern(pattern);
                         indexOrder = that.componentOrders[indexKey];
                         index = that.queriesIndexMap[indexKey];

                         for(var i=0; i<indexOrder.length; i++) {
                             var component = indexOrder[i];
                             var quadValue = normalized[component];
                             if(typeof(quadValue) === 'string') {
                                 if(index['_'] == null) {
                                     index['_'] = [];
                                 }
                                 index['_'].push(counter);
                                 break;
                             } else {
                                 if(i===indexOrder.length-1) {
                                     index[quadValue] = index[quadValue] || {'_':[]};
                                     index[quadValue]['_'].push(counter);
                                 } else {
                                     index[quadValue] = index[quadValue] || {};
                                     index = index[quadValue];
                                 }
                             }
                         }

                         k(floop,env);
                     });
                 },
                 function(env) {
                     that.engine.execute(query,
                                         function(success, results){
                                             if(success){
                                                 callback(results);
                                             } else {
                                                 console.log("ERROR in query callback "+results);
                                             }                                             
                                         });
                     if(endCallback != null)
                         endCallback();
                 });
};

Callbacks.CallbacksBackend.prototype.stopObservingQuery = function(query) {
    var id = this.queriesInverseMap[query];
    if(id != null) {
        delete this.queriesInverseMap[query];
        delete this.queriesMap[id];
        this.queriesList = Utils.remove(this.queriesList, id);
    }
};

Callbacks.CallbacksBackend.prototype._searchQueriesInIndex = function(index, order, quadPair) {
    var quadPairNomalized = quadPair[1];
    var quadPair = quadPair[0];

    for(var i=0; i<(order.length+1); i++) {
        var matched = index['_'] || [];
        
        var filteredIds = [];
        for(var j=0; j<matched.length; j++) {
            var queryId = matched[j];
            if(Utils.include(this.pendingQueries,queryId)) {
                Utils.remove(this.pendingQueries,queryId);
                this.matchedQueries.push(queryId);
            }
            // removing IDs for queries no longer being observed
            if(this.queriesMap[queryId] != null) {
                filteredIds.push(queryId);
            }
        }
        index['_'] = filteredIds;

        var component = order[i];
        if(index[''+quadPairNomalized[component]] != null) {
            index = index[''+quadPairNomalized[component]];
        } else {
            break;
        }
    }
};

Callbacks.CallbacksBackend.prototype.dispatchQueries = function(callback) {
    var that = this;
    var floop, query, queryId, queryCallback;
    Utils.repeat(0, this.matchedQueries.length,
                 function(k, env){
                     floop = arguments.callee;
                     queryId = that.matchedQueries[env._i];
                     query = that.queriesMap[queryId];
                     queryCallback = that.queriesCallbacksMap[queryId];
                     Utils.recur(function(){
                         that.engine.execute(query, 
                                             function(success, results){
                                                 if(success) {
                                                     queryCallback(results);
                                                 } else {
                                                     console.log("ERROR executing query callback "+results);
                                                 }
                                                 k(floop,env);
                                             });
                     });
                 },
                 function(env) {
                     callback();
                 });
};
