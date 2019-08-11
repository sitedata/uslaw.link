const async = require('async');
const request = require('request');
const fs = require('fs');
const url = require('url');
const xml2js = require('xml2js');
const yaml = require('js-yaml');

const Citation = require('./citation');

exports.explode = function(cite, env, callback) {
  if (cite.stat && cite.stat.volume <= 64) {
    // Use the Legisworks Statutes at Large data to explode ambiguous
    // SAL citations into multiple entries.
   get_from_legisworks(cite, function(matches) {
    callback(null, matches);
   });
   return;
  }

  callback(null, [cite]);
}

exports.add_parallel_citations = function(cite, env, callback) {
  // Run the parallel citation fetchers over any available citation matches.
  // Each fetcher can either:
  //   1) Adorn 'cite' with new link sources.
  //   2) Call callback() passing an array of other citations to display.
  var new_citations = [ ];
  async.forEachOf(fetchers, function (fetcher_function, cite_type, callback) {
    if (!(cite_type in cite)) {
      // citation of this type not present in the citation
      callback();
      return;
    }

    // Call the fetcher function.
    fetcher_function(cite[cite_type], cite, env, function(new_cites) {
      // It gives us back an array of new citations. Accumulate them.
      new_cites.forEach(function(item) { new_citations.push(item); })
      callback(); // signal OK
    })
  }, function(err) {
    // all fetchers have run
    callback(new_citations);
  });
}

var fetchers = {
  stat: function(stat, cite, env, callback) {
    // If we have a link to US GPO's GovInfo.gov side, load the MODS XML
    // metadata file for additional information.
    if (stat.links.usgpo)
      get_from_usgpo_mods(cite, stat.links.usgpo.mods, callback);
    else
      callback([])
  },
  law: function(law, cite, env, callback) {
    if (law.links.usgpo)
      get_from_usgpo_mods(cite, law.links.usgpo.mods, callback);
    else if (law.congress >= 60 && law.congress <= 81)
      get_from_legisworks_publaw(cite, callback);
    else if (law.links.govtrack && law.links.govtrack.landing)
      get_from_govtrack_search(cite, law.links.govtrack, true, callback);
    else
      callback([])
  },
  usc: function(usc, cite, env, callback) {
    // Because of the ambiguity of dashes being within section numbers
    // or delineating ranges, we can test if the citation actually exists
    // now and delete links that don't resolve by pinging the House OLRC
    // URL. (OLRC is always up to date. GPO only publishes 'published'
    // volumes and can be behind and not have new sections (or even titles).
    if (usc.links && usc.links.house && usc.links.house.html) {
      request.get({
        uri: usc.links.house.html,
        followRedirect: false
      }, function (error, response, body) {
        // When the link fails, OLRC gives a status 302 with a redirect to
        // a docnotfound page.
        if (response.statusCode != 200)
          delete cite.usc.links;
        callback([]);
      });
    } else {
      callback([])
    }
  },
  cfr: function(cfr, cite, env, callback) {
    if (cfr.links.usgpo)
      get_from_usgpo_mods(cite, cfr.links.usgpo.mods, callback);
    else
      callback([])
  },
  fedreg: function(fedreg, cite, env, callback) {
    if (fedreg.links.usgpo)
      get_from_usgpo_mods(cite, fedreg.links.usgpo.mods, callback);
    else
      callback([])
  },
  reporter: function(reporter, cite, env, callback) {
    get_from_courtlistener_search(cite, env, callback);
  }
};

function create_parallel_cite(type, citeobj) {
  var citator = Citation.types[type];
  var ret = {
    type: type,
    type_name: citator.name,
    citation: citator.canonical ? citator.canonical(citeobj) : null,
    title: citeobj.title
  };
  ret[type] = citeobj;
  ret[type].id = citator.id(citeobj);
  ret[type].links = Citation.getLinksForCitation(type, ret[type]);
  return ret;
}

function get_from_usgpo_mods(cite, mods_url, callback) {
  // Result Stat citation to equivalent Public Law citation.
  request.get(mods_url, function (error, response, body) {
      // turn body back into a readable stream
      var xml = new xml2js.parseString(body, function (err, result) {
        if (err)
          console.log(err);

        var cites = [ ];
        var seen_cites = { };

        if (result && result.mods && result.mods.extension) {
          result.mods.extension.forEach(function(extension) {
            if (cite.type == "stat" || cite.type == "law") {

              // Statutes at Large MODS files have references to a parallel public law citations.
              if (extension.law) {
                var elem = extension.law[0].$;
                var c = create_parallel_cite('law', {
                  congress: parseInt(elem.congress),
                  type: elem.isPrivate=='true' ? "private" : "public",
                  number: parseInt(elem.number)
                });
                if (c.law.id in seen_cites) return; // MODS has duplicative info
                cites.push(c);
                seen_cites[c.law.id] = c;
              }

              // Statutes at Large and Public Law MODS files have references to an originating bill.
              if (extension.bill) {
                var elem = extension.bill[0].$;
                if (elem.priority == "primary") { // not sure what "primary" means, but I hope it means the source bill and not a bill that happens to be mentioned in the statute
                  var c = create_parallel_cite('us_bill', {
                    is_enacted: true, // flag for our linker that it's known to be enacted
                    congress: parseInt(elem.congress),
                    bill_type: elem.type.toLowerCase(),
                    number: parseInt(elem.number)
                  });
                  if (c.us_bill.id in seen_cites) return; // MODS has duplicative info
                  cites.push(c);
                  seen_cites[c.us_bill.id] = c;
                }
              }

            }

            // Statutes at Large and Public Law MODS files have title information.
            // Other MODS files have other basic title information.
            // Add the 'title' metadata field to the original citation object.
            if (extension.shortTitle) {
              var elem = extension.shortTitle[0];
              if (typeof elem == "string")
                cite.title = elem;
              else if (typeof elem._ == "string")
                cite.title = elem._;
            } else if (extension.searchTitle) {
              var elem = extension.searchTitle[0];
              cite.title = elem;
            }

          });
        }

        // Callback.
        callback(cites);
      });
    });
}

function get_from_govtrack_search(cite, govtrack_link, is_enacted, callback) {
  // The GovTrack link is to a search page. Hit the URL to
  // see if it redirects to a bill.
  var url = govtrack_link.landing;
  request.get(url, function (error, response, body) {
    var url = response.request.uri.href;
    var m = /^https:\/\/www.govtrack.us\/congress\/bills\/(\d+)\/([a-z]+)(\d+)$/.exec(url);
    if (!m) {
      // Not a bill.
      callback([])
      return;
    }

    // The search page redirected to a bill. Use the hidden .json extension
    // to get the API response for this bill.
    var cites = [];
    request.get(url + ".json", function (error, response, body) {
      try {
        var bill = JSON.parse(body);

        // Add title information to the main citation object.
        cite.title = bill.title_without_number;

        // This citation is for a law, so add a new parallel citation
        // record for the bill.
        cites.push(create_parallel_cite('us_bill', {
          is_enacted: is_enacted, // flag for our linker that it's known to be enacted
          congress: parseInt(bill.congress),
          bill_type: m[2], // easier to scrape from URL, code is not in the API response
          number: parseInt(bill.number),
          title: bill.title
        }));

        // Delete the original govtrack link now that we have a better link
        // as a parallel citation.
        delete cite.law.links.govtrack;
      } catch (e) {
        // ignore error
      }
      callback(cites)
    });
  });
}

function get_from_legisworks(cite, callback) {
  // Look up this citation in the Legisworks data.
  function pad(n, width, z) {
    // https://stackoverflow.com/questions/10073699/pad-a-number-with-leading-zeros-in-javascript
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
  }

  // Get the YAML file for the volume.
  var body = fs.readFileSync("legisworks-historical-statutes/data/" + pad(cite.stat.volume, 3) + ".yaml")
  body = yaml.safeLoad(body);

  // Search for a matching entry. There may be more than one, so we
  // accumulate new entries if needed. We allow targetting the first
  // page as well as any internal page of an entry.
  var matches = [];
  body.forEach(function(item) {
    if ((""+item.volume) != cite.stat.volume)
      return;
    if (!(
      (""+item.page) == cite.stat.page
      || (
        item.npages
        && parseInt(cite.stat.page) >= item.page
        && parseInt(cite.stat.page) < (item.page + item.npages)
      )))
      return;
    matches.push(item);
  });

  matches = matches.map(function(item) {
    // Create a fresh citation entry for this match.
    var c = create_parallel_cite('stat', {
      volume: cite.stat.volume,
      page: cite.stat.page,
    });
  
    // Add the title metadata.
    c.title = item.title || item.topic;

    // Replace the citation with the start page of the entry.
    c.citation = item.volume + " Stat. " + item.page;

    // If there are multiple matches, disambiguate.
    if (matches.length > 1)
      c.disambiguation = item.citation;

    // Add a link.
    var is_start_page = (""+item.page) == cite.stat.page;
    c.stat.links.legisworks = {
      source: {
          name: "Legisworks",
          abbreviation: "Legisworks",
          link: "https://github.com/unitedstates/legisworks-historical-statutes",
          authoritative: false,
      },
      pdf: "https://govtrackus.s3.amazonaws.com/legislink/pdf/stat/" + item.volume + "/" + item.file
    };
    if (!is_start_page)
      c.stat.links.legisworks.source.note = "Link is to an internal page within a statute beginning on page " + item.page + ".";

    // If there is public law information, make a parallel citation.
    if (item.congress >= 38 && item.type == "publaw") {
      var cc = create_parallel_cite('law', {
        congress: item.congress,
        type: "public",
        number: item.number
      });
      cc.title = item.title || item.topic;
      c.parallel_citations = [cc];
    }

    return c;
  });

  // Go in reverse order. If there are multiple matches, prefer ones that
  // start on this page rather than ones that end on this page.
  matches.reverse();

  // Finish.
  callback(matches);
}

function get_from_legisworks_publaw(cite, callback) {
  // Which volume is this Congress in?
  var volume_map = {
    60: [35], 61: [36], 62: [37], 63: [38], 64: [39], 65: [40], 66: [41], 67: [42], 68: [43], 69: [44],
    70: [45], 71: [46], 72: [47], 73: [48], 74: [49], 75: [50], 75: [51, 52], 76: [53, 54], 77: [55, 56],
    78: [57, 58], 79: [59, 60], 80: [61, 62], 81: [63, 64]
  };
  if (!volume_map[cite.law.congress]) {
    callback([]);
    return;
  }

  var parallel_cites = [];

  volume_map[cite.law.congress].forEach(function(volume) {
    function pad(n, width, z) {
      // https://stackoverflow.com/questions/10073699/pad-a-number-with-leading-zeros-in-javascript
      z = z || '0';
      n = n + '';
      return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
    }

    // Get the YAML file for the volume.
    var body = fs.readFileSync("legisworks-historical-statutes/data/" + pad(volume, 3) + ".yaml")
    body = yaml.safeLoad(body);

    body.forEach(function(item) {
      if (""+item.congress != cite.law.congress)
        return;
      if (""+item.number != cite.law.number)
        return;
      if (cite.law.type == "public" && item.type != "publaw")
        return;
      if (cite.law.type == "private")
        return;

      // Add metadata.
      cite.title = item.title || item.topic;

      // Add link information.
      cite.law.links.legisworks = {
        source: {
            name: "Legisworks",
            abbreviation: "Legisworks",
            link: "https://github.com/unitedstates/legisworks-historical-statutes",
            authoritative: false,
        },
        pdf: "https://govtrackus.s3.amazonaws.com/legislink/pdf/stat/" + item.volume + "/" + item.file
      };

      // Add Stat parallel citation. No need to create a link because
      // it would go to the very same resource.
      parallel_cites.push(create_parallel_cite('stat', {
        volume: item.volume,
        page: item.page,
      }));
    });
  });

  callback(parallel_cites);
  return;

  // Look up this citation in the Legisworks data.

  // Search for a matching entry. There may be more than one, so we
  // accumulate new entries if needed. We allow targetting the first
  // page as well as any internal page of an entry.
  var matches = [];
  body.forEach(function(item) {
    if ((""+item.volume) != cite.stat.volume)
      return;
    if (!(
      (""+item.page) == cite.stat.page
      || (
        item.npages
        && parseInt(cite.stat.page) >= item.page
        && parseInt(cite.stat.page) < (item.page + item.npages)
      )))
      return;
    matches.push(item);
  });

  matches = matches.map(function(item) {
    // Create a fresh citation entry for this match.
    var c = create_parallel_cite('stat', {
      volume: cite.stat.volume,
      page: cite.stat.page,
    });
  
    // Add the title metadata.
    c.title = item.title || item.topic;

    // Replace the citation with the start page of the entry.
    c.citation = item.volume + " Stat. " + item.page;

    // If there are multiple matches, disambiguate.
    if (matches.length > 1)
      c.citation += " (" + item.citation + ")";

    // Add a link.
    var is_start_page = (""+item.page) == cite.stat.page;
    c.stat.links.legisworks = {
      source: {
          name: "Legisworks",
          abbreviation: "Legisworks",
          link: "https://github.com/unitedstates/legisworks-historical-statutes",
          authoritative: false,
      },
      pdf: "https://govtrackus.s3.amazonaws.com/legislink/pdf/stat/" + item.volume + "/" + item.file
    };
    if (!is_start_page)
      c.stat.links.legisworks.source.note = "Link is to an internal page within a statute beginning on page " + item.page + ".";

    // If there is public law information, make a parallel citation.
    if (item.congress >= 38 && item.type == "publaw") {
      var cc = create_parallel_cite('law', {
        congress: item.congress,
        type: "public",
        number: item.number
      });
      cc.title = item.title || item.topic;
      c.parallel_citations = [cc];
    }

    return c;
  });

  // Go in reverse order. If there are multiple matches, prefer ones that
  // start on this page rather than ones that end on this page.
  matches.reverse();

  // Finish.
  callback(matches);
}

function get_from_courtlistener_search(cite, env, callback) {
  var link = cite.reporter.links.courtlistener;
  if (link && env.courtlistener) {
    // This case is believed to be available at CourtListener. Do a search
    // for the citation at CL and use the first result.
    request.get('https://www.courtlistener.com/api/rest/v3/search/?' + url.parse(link.landing).query,
      {
        auth: {
          user: env.courtlistener.username,
          pass: env.courtlistener.password,
          sendImmediately: true
        }
      }, function (error, response, body) {
        try {
          if (error || !body) throw "no response";
          var cases = JSON.parse(body).results;
          if (cases.length == 0) throw "no results";

          // If there is a single unique response, just update the citation in place.
          if (cases.length == 1) {
            cite.title = cases[0].caseName; // add this, not provided by citation library
            cite.type_name = cases[0].court; // add this, not provided by citation library
            cite.citation = cases[0].citation[0]; // replace this --- citation library does a bad job of providing a normalized/canonical citation
            cite.reporter.links.courtlistener = { // replace with new link
              source: {
                  name: "Court Listener",
                  abbreviation: "CL",
                  link: "https://www.courtlistener.com",
                  authoritative: false
              },
              landing: "https://www.courtlistener.com" + cases[0].absolute_url
            };

            callback([]);
            return;
          }

          // There are multiple matches for this citation. Preserve the original
          // link to the CL search page.

        } catch (e) {
        }

        callback([])
      })
  } else {
    callback([])
  }
}
