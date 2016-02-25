var fs = require("fs");
var htmlparser = require("htmlparser2");
var util = require('util');

var injectedCSS = fs.readFileSync("frontend.css", 'utf8');
var injectedJS = fs.readFileSync("frontend.js", 'utf8');

//takes an optinal path and an opional callback
//if there is a path, read and parse said file
//if reading it or parsing it causes a problem, call the callback
//stating the problem
function HtmlFile(path, callback){
	if(path != undefined){
		this.path = path;
		var self = this;
		fs.readFile(path, 'utf8', function(err, data){
			if(callback !== undefined && err){
				callback(err);
				return;
			}
			self.rawSource = data;
			self.parsedHtml = parse(data);
			if(callback){
				callback(null);
			}
		});
	}
}

HtmlFile.prototype.webSrc = function(){
	//transform the internal html sturcture into websource only when it's requested

	var webSourceHtml = stripElements(this.parsedHtml, true);

	//and for now... just assume this is a full html document
	//this basically just adds the required css and js to the head
	//also set the index attribute
	var head = htmlparser.DomUtils.filter(function(elem){
		if(elem.index != undefined){
			elem.attribs['meta-brackets-element-index'] = elem.index;
		}
		return htmlparser.DomUtils.getName(elem) == 'head';
	}, webSourceHtml)[0];

	if(head !== undefined){
		htmlparser.DomUtils.appendChild(head, {
			type: 'script',
			name: 'script',
			attribs: {language: 'javascript'},
			children: [{
				data: injectedJS,
				type: 'text'
			}]
		});
		htmlparser.DomUtils.appendChild(head, {
			type: 'style',
			name: 'style',
			children: [{
				data: injectedCSS,
				type: 'text'
			}]
		});
	}else{
		throw 'currently, only a full html document is supported';
	}

	return htmlparser.DomUtils.getOuterHTML(webSourceHtml);
};

HtmlFile.prototype.tagFromPosition = function(line, column){
	if(this.parsedHtml == undefined){
		throw 'tag positions not yet parsed';
	}

	var lines = this.rawSource.split('\n');

	//negative lines and columns don't correspond to any element
	if(line < 0 || column < 0){
		return null;
	}
	//if the line requested is larger than the number of lines in
	//the file, then it must be out of bounds
	if(line >= lines.length){
		return null;
	}
	//if the column requested is larger than the number of columns in the
	//requested line, then is must be out of bounds
	if(column >= lines[line].length){
		return null;
	}

	//convert the line and column into a character index
	var charIndex = 0;

	charIndex += column;
	line--;
	while(line >= 0){
		charIndex += lines[line].length + 1;
		line--;
	}

	return tagNumFromIndex(charIndex, {
		name: 'none',
		index: 0,
		children: this.parsedHtml
	});
};

//takes a string which will be the new content
//parses said string
//compares the parsed string with the current contents
//calls the callback with a list of differences between the new contents and current
//or, if there are no differences, doesn't call it
//changes this files contents to the new contents
HtmlFile.prototype.setContent = function(newHtml, callback){
	var newParsedHtml = parse(newHtml);
	var diff = diffParsedHtml(this.parsedHtml, newParsedHtml, true);
	if(diff.length > 0){
		callback(diff);
	}
	this.parsedHtml = newParsedHtml;
	this.rawSource = newHtml;
};

//takes an html element and returns a string represtenting it's hash, if two
//elements have the same hash, they are likely the same element
function hashElem(elem){
	if(elem.type == 'text'){
		return elem.type;
	}else{
		return elem.type + elem.name;
	}
}

function arrayDiff(left, right, hashFunc, edit_left){
	if(edit_left != true){
		left = left.slice();
	}
	var diff = [];

	function addDiff(action, index, arg){
		newAction = {
			'action': action,
			'index': index,
		}
		switch(action){
			case 'add':
				newAction['value'] = arg;
				left.splice(index, 0, arg)
				break;
			case 'remove':
				left.splice(index, 1)
				break;
			case 'move':
				newAction['to'] = arg;
				var temp = left[index];
				left.splice(index, 1)
				left.splice(arg, 0, temp)
				break;
		}

		diff.push(newAction);
	}

	for(var i = 0; i < Math.max(left.length, right.length); i++){
		if(left[i] == undefined){
			addDiff('add', i, right[i]);
			continue;
		}
		if(right[i] == undefined){
			addDiff('remove', i);
			continue;
		}

		if(hashFunc(left[i]) == hashFunc(right[i])){
			continue;
		}

		//try to find left value in right
		for(var j = i; j < left.length; j++){
			if(hashFunc(left[j]) == hashFunc(right[i])){
				addDiff('move', j, i);
				break;
			}else if(j == left.length - 1){
				addDiff('remove', i);
				if(left[i] == undefined || hashFunc(left[i]) != hashFunc(right[i])){
					addDiff('add', i, right[i]);
				}
				break;
			}
		}
	}

	return diff;
}

//takes an element created by htmlparser2 and strips the meta information
function stripElement(elem, include_index){
	var newElem = {
		type: elem.type
	};

	if(elem.name)
		newElem.name = elem.name;

	if(include_index && elem.index)
		newElem.index = elem.index;

	if(elem.attribs)
		newElem.attribs = elem.attribs;

	if(elem.data)
		newElem.data = elem.data;

	if(elem.children != undefined){
		newElem.children = elem.children.slice();
		newElem.children.forEach(function(value, index, array){
			array[index] = stripElement(value, include_index);
		});
	}

	return newElem;
}

function stripElements(elems, include_index){
	var newElems = [];

	elems.forEach(function(elem){
		newElems.push(stripElement(elem, include_index));
	});

	return newElems;
}

//takes two arrays of json dom elements and returns the difference
function diffParsedHtml(left, right, edit_left, parent){
	if(parent == undefined){
		parent = 0;
	}
	if(edit_left != true){
		left = left.slice();
	}

	var diff = [];

	var selfDiff = {
		'element': parent,
		'changes': []
	};

	var longestSide = (left.length > right.length) ? left.length : right.length;
	for(var elem = 0; elem < longestSide; elem++){
		var leftElem = left[elem];
		var rightElem = right[elem];

		if(leftElem == undefined){
			console.log('adding element to end');
			continue;
		}

		if(rightElem == undefined){
			console.log('removing element from end');
			continue;
		}

		//get a "hash" of both he right and left elements
		var leftHash = JSON.stringify(stripElement(leftElem, false));
		var rightHash = JSON.stringify(stripElement(rightElem, false));

		//this can then be used to determine if both the right and left
		//are EXACTLY THE SAME
		if(leftHash == rightHash){
			//then just continue on to the next elements
			continue;
		}

		//okay so we can conclude that something is different about these two
		//elements, we just need to find out what that is

		//this says weather changes can be made to make the element in left
		//in order to make it equivalent to right (true), otherwise it will try
		//and search for it or just add/remove this element
		//= 0 : not really conclusive...
		//> 0 : transition-able
		//< 0 : not transition-able
		var transitionability = 0;

		//this only really applies to tags, dictates whether or not there is
		//a difference between their children. This saves a lot of time
		//if only minor parts of an element aren't changed
		var sameChidlren = false;

		//first just see if they're the same type of element
		if(leftElem.type != rightElem.type){
			//if not, these elements are completely incompatible
			transitionability = -1;
		}else{
			//if they are, there's a pretty good chance that a transition
			//can be made from left to right
			if(leftElem.type == 'text'){
				//text objects can definitely be transitioned, all they have
				//is text data
				transitionability = 1;
			}else{
				//the element's name could be all the changed, so this doesn't
				//necessarily mean it's an entirely new element
				if(leftElem.name == rightElem.name){
					transitionability++;
				}else{
					transitionability--;
				}

				var leftChildHash = JSON.stringify(
						stripElements(leftElem.children, false));
				var rightChildHash = JSON.stringify(
						stripElements(rightElem.children, false));
				if(leftChildHash == rightChildHash){
					//they both have exactly the same children, so it's pretty
					//likely a smooth transition can be made with only minor
					//tweaks to this element
					sameChidlren = true;

					transitionability += 2;  //extra points, because
					//transitioning children can be really easy
				}else{
					//not the same children, but that doesn't
					//mean the children can't be modified in order to make
					//these elements the same

					//(this is here just for clarity)
				}
			}
		}

		console.log('from:');
		console.log(leftElem);
		console.log('to:');
		console.log(rightElem);
	}

	//left.forEach(function(leftElem, i){
		//var rightElem = right[i];
		//if(leftElem.type == 'text'){
			//if(leftElem.data != rightElem.data){
				//selfDiff.changes.push({
					//'index': i,
					//'action': 'change',
					//'what': 'text',
					//'value': rightElem.data
				//});
			//}
		//}else{
			//if(leftElem.children != undefined && rightElem.children != undefined){
				//var subDiff = diffParsedHtml(
						//leftElem.children,
						//rightElem.children,
						//true,
						//leftElem.index);
				//if(subDiff.length > 0){
					//diff = diff.concat(subDiff);
				//}
			//}
		//}
	//});

	if(selfDiff.changes.length != 0){
		diff = diff.concat(selfDiff);
	}

	return diff;
}

function parse(inputSrc){
	var handler = new htmlparser.DomHandler({withStartIndices: true});

	//for whatever reason, the domhandler doesn't have an option to add the
	//end index to elements, so this rewrites the function to do so
	handler._setEnd = function(elem){
		elem.endIndex = this._parser.endIndex;
	};
	handler.onprocessinginstruction = function(name, data){
		this._parser.endIndex = this._parser._tokenizer._index;
		htmlparser.DomHandler.prototype.onprocessinginstruction.call(this, name, data);
	};
	handler._addDomElement = function(elem){
		htmlparser.DomHandler.prototype._addDomElement.call(this, elem);
		this._setEnd(elem);
	};
	handler.onclosetag =
	handler.oncommentend =
	handler.oncdataend = function onElemEnd() {
		this._setEnd(this._tagStack.pop());
	};

	var parser = new htmlparser.Parser(handler);
	parser.write(inputSrc);
	parser.done();

	var parsedHtml = handler.dom;

	//give each element an index
	var elementIndex = 1;	//0 is for root
	htmlparser.DomUtils.filter(function(elem){
		if(elem.type == 'tag' || elem.type == 'style' || elem.type == 'script'){
			elem.index = elementIndex;
			elementIndex++;
		}
	}, parsedHtml);

	return parsedHtml;
};

function tagNumFromIndex(index, elem){
	for(var i = 0; i < elem.children.length; i++){
		var child = elem.children[i];
		if(child.type == 'tag'
				&& index >= child.startIndex
				&& index <= child.endIndex){
			child = tagNumFromIndex(index, elem.children[i]);
			if(child != null){
				return child;
			}
		}
	}

	return elem;
};

module.exports = HtmlFile;
