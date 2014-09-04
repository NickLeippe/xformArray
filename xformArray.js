/*****************************************************************************
 *
 *  transform array (ko.xformArray)
 *
 *  Produces an observable array that tracks a source observable array,
 *  optionally employing any combination of:
 *  - mapping source items into something else in the tracking array
 *  - filtering the source array (only including a subset in the tracking array)
 *  - sorting:
 *    - track the source array's sort order
 *    - specify a sort order specific to the tracking array's items
 *    - specify no sort order at all for the tracking array
 *
 *  mapping is established at creation, whereas filtering and sorting
 *  can be changed at any time
 *
 *  Caveat emptor:
 *
 *  The tracking array should be considered read-only--it is a one-way sync.
 *  Changes to the order of items, or addition/removal of items in the tracking
 *  array itself will have no affect on the source array and may break
 *  the sync code.
 *
 *  We could wrap the result in a ko computed to enforce this, but that
 *  would defeat foreach optimizations employed in concert with the
 *  observable array code which are highly desireable.
 *
 *  However, changing the items themselves *will* change the items in the
 *  source array since (w/o mapping) they will be the self-same objects.
 *
 *  options: { // ns == not set
 *    map:    ns | falsy | function(s)      -> t
 *    maps_p: ns | falsy | function(s, t)   -> true | false (whether s maps to t, required if mapFn provided)
 *    filter: ns | falsy | function(s)      -> true | false (whether to include s in tracking array)
 *    sort:   ns | falsy                       no sorting--impose no order
 *                       | true                use the same sort order as the source array--the default
 *                       | function(t1, t2) -> -1 | 0 | 1 (sort() cmp compatible function)
 *  }
 *
 ****************************************************************************/
define(function(require) {
	'use strict';

	var ko = require('vendor/knockout');

	// factory
	ko.xformArray = function(srcArr, options) {
		return new XformArray(srcArr, options);
	};

	/*********************************************************************
	 *
	 *  ctor
	 *
	 ********************************************************************/
	function XformArray(
		srcArr, // an observable array to track
		options)
	{
		this.map         = undefined;
		this.maps_p      = undefined;
		this.filter      = undefined;
		this.sort        = true;
		this.srcArr      = srcArr;
		this.trackingArr = ko.obsArr();

		// embellish the obsArr we return
		this.trackingArr.setFilter = XformArray.prototype.setFilter.bind(this);
		this.trackingArr.setSort   = XformArray.prototype.setSort.bind(this);

		options = options || {};
		if ('maps_p' in options) {
			this.maps_p = options.maps_p;
		}
		if ('map' in options) {
			this.map = options.map;
			if (!this.maps_p) {
				throw new Error('map specified without maps_p');
			}
/*
		} else {
			this.map    = function(s) { return s; };
			this.maps_p = function(s, t) { return s === t };
*/
		}
		if ('filter' in options) {
			this.filter = options.filter;
		}
		if ('sort' in options) {
			this.sort = options.sort;
		}

		this.srcArr.subscribe(
			this.trackArrayChanges,
			this,
			'arrayChange'
		);
		this.sync();
		this.monitorElementChanges();
		return this.trackingArr;
	}

	/*********************************************************************
	 *
	 *  monitorElementChanges() - manage subscribing to filter() and/or
	 *                            sort() on each element in case they refer
	 *                            to observables
	 *
	 *  There's a trade-off here. Creating separate observables for
	 *  filter() and sort() means that so long as they don't look at
	 *  the same observables on an element we get some performance
	 *  boost. Also, if we change the sorting we only have to update the
	 *  one for sort.
	 *
	 *  However, if filter() and sort() look at the same observable in
	 *  an element (or elsewhere), this means that if that one changes
	 *  both will fire, probably (need to confirm) causing it to
	 *  recompute twice.
	 *
	 *  Merging them into a single observable would mean that we couldn't
	 *  optimize a filter change independently from a sort change, but
	 *  would prevent it from ever recomputing twice for the same change.
	 *
	 ********************************************************************/
	XformArray.prototype.monitorElementChanges = function() {
		this.monitorFilterChanges();
		this.monitorSortChanges();
	};

	XformArray.prototype.monitorFilterChanges = function() {
		if (this._obsFilter) {
			this._obsFilter.dispose();
			delete this._obsFilter;
		}
		this._obsFilter = this.observeFilterChanges();
		this._obsFilter.extend({ notify: 'always' }).subscribe(
			this.trackElementChanges,
			this
		);
	};

	XformArray.prototype.monitorSortChanges = function() {
		if (this._obsSort) {
			this._obsSort.dispose();
			delete this._obsSort;
		}
		this._obsSort = this.observeSortChanges();
		this._obsSort.extend({ notify: 'always' }).subscribe(
			this.trackElementChanges,
			this
		);
	};

	XformArray.prototype.observeFilterChanges = function() {
		return ko.obsFn({
			owner: this,
			read: function() {
				if (!this.filter) {
					return;
				}
				var i;
				var s_arr = this.srcArr.peek();
				var s_len = s_arr.length;
				for (i = 0; i < s_len; i++) {
					this.filter(s_arr[i]);
				}
			}
		});
	};

	XformArray.prototype.observeSortChanges = function() {
		return ko.obsFn({
			owner: this,
			read: function() {
				if (!isFunction(this.sort)) {
					return;
				}
				var i;
				var t_arr = this.trackingArr.peek();
				var t_len = t_arr.length;
				for (i = 1; i < t_len; i++) {
					this.sort(t_arr[i - 1], t_arr[i]);
				}
			}
		});
	};


	/*********************************************************************
	 *
	 *  trackElementChanges() -- subscription handler for observables
	 *                           within elements that affect filter()
	 *                           and/or sort()
	 *
	 ********************************************************************/
	XformArray.prototype.trackElementChanges = function() {
		this.sync();
		this.monitorElementChanges();
	};

	/*********************************************************************
	 *
	 *  sync() -- sync tracking array to source array considering all
	 *            combinations of settings
	 *
	 ********************************************************************/
	XformArray.prototype.sync = function() {
		if (this.sort === true) { // match sort order of source array
			this.syncSameSort();
		} else if (this.sort) {   // custom sort
			this.syncCustomSort();
		} else {                    // no sorting at all
			this.syncNoSort();
		}
	};

	/*********************************************************************
	 *
	 *  syncSameSort() -- sync tracking array to source array
	 *                    when sort === true
	 *
	 ********************************************************************/
	XformArray.prototype.syncSameSort = function() {
		var si    = 0;
		var s_arr = this.srcArr.peek();
		var s_len = s_arr.length;
		var s;
		var ti    = 0;
		var ti2;
		var t;
		var t_arr = this.trackingArr.peek();

		for (; si < s_len; si++) {
			s = s_arr[si];
			ti2 = this.indexOfTrackingMappedToSource(s, ti);

			if (!this.filter || this.filter(s)) {
				// add it
				if (ti2 < 0) { // only if not there
					if (this.map) {
						this.trackingArr.splice(ti, 1, this.map(s));
					} else {
						this.trackingArr.splice(ti, 1, s);
					}
				} else if (ti !== ti2) {
					// move it to where it belongs
					t = this.trackingArr.splice(ti2, 1);
					this.trackingArr.splice(ti, 1, t[0]);
				}
				ti++;
			} else {
				// remove it
				if (0 <= ti2) { // only if found
					this.trackingArr.splice(ti2, 1);
				}
			}
		}

		// truncate remaining
		if (ti < t_arr.length) {
			this.trackingArr.splice(ti, t_arr.length - ti);
		}
	};

	/*********************************************************************
	 *
	 *  syncNoSort() -- sync tracking array to source array
	 *                  when !sort
	 *
	 ********************************************************************/
	XformArray.prototype.syncNoSort = function() {
		var si      = 0;
		var s_arr   = this.srcArr.peek();
		var s_len   = s_arr.length;
		var s;
		var ti      = 0;
		var t_arr   = this.trackingArr.peek();
		var tmp_arr;

		for (; si < s_len; si++) {
			s = s_arr[si];
			ti = this.indexOfTrackingMappedToSource(s);
			if (!this.filter || this.filter(s)) {
				// we want it in the array
				if (ti < 0) {
					// don't have it yet, so add it
					if (this.map) {
						this.trackingArr.push(this.map(s));
					} else {
						this.trackingArr.push(s);
					}
				} // else already has it
			} else {
				// we don't want it anymore
				if (0 <= ti) {
					// we have it, so remove it
					this.trackingArr.splice(ti, 1);
				}
			}
		}
/* -- no, we're not done, items could have been removed we need to remove them from the tracking array still
this case would only be true if syncNoSort() is only called at initialization
		if (!this.filter) {
			return; // done
		}
*/
		/*
		 * remove unfiltered items from trackingArr
		 */

		// first create a sparse array of t_arr's valid index entries
		tmp_arr = [];
		for (si = 0; si < s_len; si++) {
			// mark it to keep
			ti = this.indexOfTrackingMappedToSource(s_arr[si]);
			tmp_arr[ti] = undefined; // no point allocating anything beyond the property name itself
		}

		// then remove all the rest
		for (ti = t_arr.length - 1; 0 <= ti; ti--) {
			if (! (ti in tmp_arr)) {
				this.trackingArr.splice(ti, 1);
			}
		}
	};

	/*********************************************************************
	 *
	 *  syncCustomSort() -- sync tracking array to source array
	 *                      when isFunction(sort)
	 *
	 ********************************************************************/
	XformArray.prototype.syncCustomSort = function() {
		this.syncNoSort();
		this.trackingArr.sort(this.sort);
	};

	/*********************************************************************
	 *
	 *  indexOfTrackingMappedToSource() -- return -1 if not found
	 *                                     return index of item in
	 *                                     tracking array that maps to
	 *                                     the source array item s
	 *
	 ********************************************************************/
	XformArray.prototype.indexOfTrackingMappedToSource = function(
		s,
		startFromIdx) // optional
	{
		var ta  = this.trackingArr.peek();
		var i   = startFromIdx || 0;
		var len = ta.length;
		if (this.maps_p) {
			for (; i < len; i++) {
				if (this.maps_p(s, ta[i])) {
					return i;
				}
			}
		} else {
			for (; i < len; i++) {
				if (s === ta[i]) {
					return i;
				}
			}
		}
		return -1;
	};

	/*********************************************************************
	 *
	 *  trackSingleChange() -- process single change
	 *                         returns true if an item was added
	 *
	 ********************************************************************/
	XformArray.prototype.trackSingleChange = function(
		s_change,
		one_of_multiple) // optional flag
	{
		if (s_change.status === 'added') {
			return this.trackAddChange(s_change, one_of_multiple);
		} else if (s_change.status === 'deleted') {
			this.trackDeleteChange(s_change, one_of_multiple);
		}
	};

	/*********************************************************************
	 *
	 *  trackAddChange() -- process a single 'added' change
	 *                      returns true if an item was actually added
	 *
	 ********************************************************************/
	XformArray.prototype.trackAddChange = function(
		s_change,
		skip_sort) // optional flag
	{
		var s_arr;
		var si;
		var new_t;
		var ti;
		var prev_s;

		if (this.filter && !this.filter(s_change.value)) {
			return; // nothing to do
		}

		if (this.map) {
			new_t = this.map(s_change.value);
		} else {
			new_t = s_change.value;
		}

		if (this.sort !== true) { // diff order or no order
			this.trackingArr.push(new_t);
			if (this.sort && !skip_sort) {
				this.trackingArr.sort(this.sort);
			}
			return true;
		}

		// else we are tracking the sort order of the source array

		if (!this.filter) { // no filtering--1 to 1
			// just put it in the same place
			this.trackingArr.splice(s_change.index, 0, new_t);
			return true;
		}

		// else tracking arr is a filtered subset of source arr

		if (s_change.index === 0) {
			// it goes first
			this.trackingArr.unshift(new_t);
			return true;
		}

		s_arr = this.srcArr.peek();
		if (s_change.index === s_arr.length - 1) {
			// it goes last
			this.trackingArr.push(new_t);
			return true;
		}

		// else we need to find where it goes in t_arr

		// 1) find the first s before s_change.index that is in t_arr
		for (si = s_change.index - 1; 0 <= si; si--) {
			prev_s = s_arr[si];
			if (this.filter(prev_s)) {
				break;
			}
		}

		if (si < 0) { // it goes first
			this.trackingArr.unshift(new_t);
			return true;
		}

		// 2) find index of t in t_arr where t = map(prev_s)
		ti = this.indexOfTrackingMappedToSource(prev_s);

		// 3) insert the new t after
		this.trackingArr.splice(ti + 1, 0, new_t);

		return true;
	};

	/*********************************************************************
	 *
	 *  trackDeleteChange() -- process a single 'deleted' change
	 *
	 ********************************************************************/
	XformArray.prototype.trackDeleteChange = function(s_change) {
		var ti;

		if (this.filter) {
			if (!this.filter(s_change.value)) {
				return; // nothing to do
			}
			ti = this.indexOfTrackingMappedToSource(s_change.value);
			if (ti < 0) { // Not in tracking--this shouldn't happen!
				return;
			}
		} else if (this.sort && this.sort !== true) {
			// custom sort, we don't know where it is in the tracked array
			ti = this.indexOfTrackingMappedToSource(s_change.value);
			if (ti < 0) { // Not in tracking--this shouldn't happen!
				return;
			}
		} else { // no filtering, no sort or same sort will
			ti = s_change.index;
		}
		this.trackingArr.splice(ti, 1);
	};

	/*********************************************************************
	 *
	 *  trackMultipleChanges() -- track list of add/delete changes
	 *
	 ********************************************************************/
	XformArray.prototype.trackMultipleChanges = function(s_changes) {
		var c;
		var c_len;
		var any_added = false;

		for (c = 0, c_len = s_changes.length;
			c < c_len;
			c++)
		{
			any_added |= this.trackSingleChange(s_changes[c], true);
		}

		// sort if necessary
		if (any_added &&
			this.sort !== true &&
			this.sort)
		{
			this.trackingArr.sort(this.sort);
		}
	};

	/*********************************************************************
	 *
	 *  trackMoveChanges() -- track list of 'moved' changes
	 *
	 ********************************************************************/
	XformArray.prototype.trackMoveChanges = function(s_changes) {

 		// moves are paired deleted, added entries with 'moved' property set

		var s_arr;
		var s_t_map;
		var len;
		var i;
		var j;
		var s_change;
		var t_changes;
		var t_arr = this.trackingArr.peek();

 		if (this.sortFn !== true) { // we're not matching source arr's sort order, so disregard
 			return; // thus a NOP
 		}
 
 		this.sync(); // do this until below is implemented/tested
 		return;

		// optimized

		if (this.filterFn) { // filtered, but match order--most difficult case

			s_arr = this.srcArr.peek();

			// 1) create an index map
			s_t_map = []; // sparse array [index in s_arr] -> index in t_arr
			len = s_changes.length;
			for (i = 0, j = 0; i < len; i++) {
				if (this.filterFn(s_arr[i])) {
					s_t_map[i] = j++;
				}
			}

			// 2) iterate s_changes and if value is in t_arr capture: index in t_arr and t
			for (i = 0; i < len; i++) {
				s_change = s_changes[i];
				if (this.filterFn(s_change.value)) {
					s_change.t_index = s_t_map[s_change.index];
					s_change.t_value = t_arr[s_change.t_index];
				}
			}

			// 3) iterate s_changes again for the values in t, apply their change
			for (i = 0; i < len; i++) {
				s_change = s_changes[i];
				if (! ('t_value' in s_change)) {
					continue;
				}
				if (s_change.status === 'added') {
				} else if (s_change.status === 'deleted') {
				}
			}

		} else { // not filtering and same order as source arr
			t_changes = [];
			len = s_changes.length;

			// 1) iterate s_changes and capture value from t_arr
			for (i = 0; i < len; i++) {
				s_change = s_changes[i];
				if (s_change.status === 'added') {
					s_change.t_value = t_arr[s_change.moved];
					//} else if (s_change.status === 'deleted') {
					//	s_change.t_value = t_arr[s_change.index];
				}
			}

			// 2) apply s_changes to t_arr
			for (i = 0; i < len; i++) {
				s_change = s_changes[i];
				if (s_change.status === 'added') {
					this.trackingArr.splice(s_change.index, 0, s_change.t_value);
				} else if (s_change.status === 'deleted') {
					this.trackingArr.splice(s_change.index, 1);
				}
			}
		}
 	};
 
	/*********************************************************************
	 *
	 *  trackArrayChanges() -- arrayChange subscription handler
	 *                         handles element additions, deletions,
	 *                         and reorderings
	 *
	 ********************************************************************/
	XformArray.prototype.trackArrayChanges = function(s_changes) {

		if (s_changes.length <= 0) {
			return; // should never happen
		}

		// single item--an add or delete
		if (1 === s_changes.length) {
			this.trackSingleChange(s_changes[0]);
			this.monitorElementChanges();
			return;
		}

		if ('moved' in s_changes[0]) { // doing a sort() or reverse()--not actually changing contents
			this.trackMoveChanges(s_changes);
			//this.monitorElementChanges(); // shouldn't have to update this here
			return;

		} else { // a list of changes, eg from a splice()
			this.trackMultipleChanges(s_changes);
			this.monitorElementChanges();
			return;
		}

		// handle all other cases
		this.sync();
		this.monitorElementChanges();
	};

	/*********************************************************************
	 *
	 *  setFilter() -- change the filter after created
	 *
	 ********************************************************************/
	XformArray.prototype.setFilter = function(fn) {
		if (!this.filter && !fn) {
			return;
		}
		if (this.filter === fn) {
			return;
		}
		this.filter = fn;
		this.sync();
		this.monitorElementChanges(); // must do both filter and sort
	};

	/*********************************************************************
	 *
	 *  setSort() -- change the sorting after created
	 *
	 ********************************************************************/
	XformArray.prototype.setSort = function(fn) {
		if (!fn) { // transition to no sorting
			this.sort = fn;
			return; // don't have to update anything
		}
		if (this.sort === fn) {
			return; // no change--nop
		}
		this.sort = fn;
		this.sync();
		this.monitorSortChanges();
	};
});
